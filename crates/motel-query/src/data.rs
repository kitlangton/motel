//! Per-call store access built on motel-store's reader primitives.
//!
//! A [`Ctx`] holds one catalog snapshot, the call's clock reading, its deadline and the set
//! of files it touched, so every answer can report exactly what it searched and whether a
//! time budget cut it short.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use motel_store::{
    collect_rows_bounded, event_row_from_sql, Catalog, CatalogEntry, EventRow, StoreError,
    EVENT_COLUMNS, NS_PER_DAY,
};
use rusqlite::params;
use rusqlite::types::{Value, ValueRef};

use crate::fingerprint::{group_message, MSG_CHARS};
use crate::ids::{EventRef, EVIDENCE_DAY};
use crate::searched::Visited;
use crate::time::Tz;
use crate::{Query, QueryError};

/// Budget for one `why` or `show` call.
const CALL_BUDGET: Duration = Duration::from_secs(5);
/// Bytes of event rows one list (a trace, a timeline, a context window) may hold, by
/// [`EventRow::estimated_bytes`]. Keeps one call well inside the daemon's 50 MB budget
/// (`docs/engine.md` §5).
pub(crate) const ROW_BYTES: usize = 4 << 20;
/// Most events a trace view reads.
pub(crate) const TRACE_ROWS: usize = 5000;
/// Services a file may have before the error scan stops merging per-service index ranges
/// and sorts instead.
const MERGE_ARMS: usize = 400;
/// Error kinds that have their own findings (crashes, runs) or live under a run (tests).
const NON_GROUP_KINDS: &str = "'crash', 'run', 'test'";

/// Columns of an error row projected for grouping. The attributes are read only when the
/// body's first [`MSG_CHARS`] characters are blank, the same rule as [`group_message`].
fn err_columns() -> String {
    format!(
        "id, ts, kind, service, name, substr(body, 1, {MSG_CHARS}),
         CASE WHEN (body IS NULL OR trim(substr(body, 1, {MSG_CHARS}), char(32, 9, 10, 13, 12)) = '')
              AND json_valid(attrs, 10) THEN json(attrs) END,
         trace_id"
    )
}

/// An error row projected for grouping.
#[derive(Debug, Clone)]
pub(crate) struct ErrRow {
    pub ev: EventRef,
    pub ts: i64,
    pub kind: String,
    pub service: String,
    pub name: Option<String>,
    /// [`group_message`] of the row.
    pub msg: String,
    pub trace_id: Option<[u8; 16]>,
}

fn lossy(v: ValueRef<'_>) -> Option<Cow<'_, str>> {
    match v {
        ValueRef::Null => None,
        ValueRef::Text(b) | ValueRef::Blob(b) => Some(String::from_utf8_lossy(b)),
        ValueRef::Integer(i) => Some(Cow::Owned(i.to_string())),
        ValueRef::Real(f) => Some(Cow::Owned(f.to_string())),
    }
}

fn err_row(r: &rusqlite::Row<'_>, day: &str) -> rusqlite::Result<ErrRow> {
    let body = lossy(r.get_ref(5)?);
    let attrs = lossy(r.get_ref(6)?);
    let trace: Option<Vec<u8>> = match r.get_ref(7)? {
        ValueRef::Blob(b) => Some(b.to_vec()),
        _ => None,
    };
    Ok(ErrRow {
        ev: EventRef::new(day, r.get(0)?),
        ts: r.get(1)?,
        kind: lossy(r.get_ref(2)?).unwrap_or_default().into_owned(),
        service: lossy(r.get_ref(3)?).unwrap_or_default().into_owned(),
        name: lossy(r.get_ref(4)?).map(Cow::into_owned),
        msg: group_message(body.as_deref(), attrs.as_deref()),
        trace_id: trace.and_then(|b| b.try_into().ok()),
    })
}

/// How a bounded scan ended.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Scan {
    pub rows: usize,
    /// Stopped by the row cap or a time budget before reading everything.
    pub truncated: bool,
}

/// Which error rows a scan reads.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ErrScan<'a> {
    pub start: i64,
    pub end: i64,
    /// Only these services; `None` = every service.
    pub services: Option<&'a [String]>,
    /// Only this kind and name (`show <g:id>`); otherwise every group kind.
    pub kind_name: Option<(&'a str, Option<&'a str>)>,
    /// Newest first within each file. Unordered scans skip the merge and are cheaper.
    pub ordered: bool,
    pub cap: usize,
    pub deadline: Instant,
}

pub(crate) struct Ctx<'q> {
    pub q: &'q Query,
    pub snap: Catalog,
    pub now: i64,
    pub tz: Tz,
    pub deadline: Instant,
    pub visited: RefCell<Visited>,
    /// Some file read stopped at a time budget.
    pub cut_short: Cell<bool>,
}

impl<'q> Ctx<'q> {
    pub fn new(q: &'q Query) -> Self {
        Self {
            q,
            snap: q.reader.catalog_snapshot(),
            now: q.now_ns(),
            tz: q.tz,
            deadline: Instant::now() + CALL_BUDGET,
            visited: RefCell::new(Visited::default()),
            cut_short: Cell::new(false),
        }
    }

    pub fn store_is_empty(&self) -> bool {
        self.snap.days.values().all(|e| e.rows <= 0)
            && self.snap.evidence.as_ref().is_none_or(|e| e.rows <= 0)
    }

    /// Files whose event-time range overlaps the window, newest first, evidence included.
    pub fn files(&self, start: i64, end: i64) -> Vec<CatalogEntry> {
        self.snap.candidates_by_max_ts_desc(start, end, true)
    }

    fn entry(&self, day: &str) -> Option<&CatalogEntry> {
        if day == EVIDENCE_DAY {
            self.snap.evidence.as_ref()
        } else {
            self.snap.days.get(day)
        }
    }

    /// Run `f` on one file and record the visit. A time budget hit returns `Ok(None)`; when
    /// it is the call's own budget (not a caller's shorter one, which the caller reports) it
    /// also marks the call [`Ctx::cut_short`].
    fn on_file<T>(
        &self,
        entry: &CatalogEntry,
        deadline: Instant,
        f: impl FnMut(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<Option<T>, QueryError> {
        self.visited.borrow_mut().add(&entry.day);
        self.read_file(entry, deadline, f)
    }

    /// [`Ctx::on_file`] for probes (staleness, last event) that are not part of what the
    /// answer searched.
    fn probe_file<T>(
        &self,
        entry: &CatalogEntry,
        f: impl FnMut(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<Option<T>, QueryError> {
        self.read_file(entry, self.deadline, f)
    }

    fn read_file<T>(
        &self,
        entry: &CatalogEntry,
        deadline: Instant,
        f: impl FnMut(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<Option<T>, QueryError> {
        let deadline = deadline.min(self.deadline);
        let timed_out = || {
            if Instant::now() >= self.deadline {
                self.cut_short.set(true);
            }
            Ok(None)
        };
        if Instant::now() >= deadline {
            return timed_out();
        }
        match self.q.reader.query_file(entry, deadline, f) {
            Ok(v) => Ok(Some(v)),
            Err(StoreError::QueryDeadlineExceeded) => timed_out(),
            Err(e) => Err(e.into()),
        }
    }

    /// Error rows of the group kinds (everything but crashes, runs and tests). Files are read
    /// newest first; an ordered scan also reads each file newest first, merging the `ix_err`
    /// range of every service rather than sorting. `f` returns false to stop.
    pub fn scan_errors(
        &self,
        spec: &ErrScan<'_>,
        mut f: impl FnMut(ErrRow) -> bool,
    ) -> Result<Scan, QueryError> {
        let cols = err_columns();
        let mut scan = Scan::default();
        let mut stopped = false;
        for entry in self.files(spec.start, spec.end) {
            if stopped {
                break;
            }
            let day = entry.day.clone();
            let res = self.on_file(&entry, spec.deadline, |conn| {
                let mut args: Vec<Value> =
                    vec![Value::Integer(spec.start), Value::Integer(spec.end)];
                let kind_filter = match spec.kind_name {
                    Some((kind, name)) => {
                        args.push(Value::Text(kind.to_owned()));
                        args.push(name.map_or(Value::Null, |n| Value::Text(n.to_owned())));
                        "kind = ?3 AND name IS ?4".to_owned()
                    }
                    None => format!("kind NOT IN ({NON_GROUP_KINDS})"),
                };
                let base = format!(
                    "SELECT {cols} FROM events INDEXED BY ix_err
                     WHERE err = 1 AND ts BETWEEN ?1 AND ?2 AND {kind_filter}"
                );
                let sql = if spec.ordered {
                    let services = match spec.services {
                        Some(s) => s.to_vec(),
                        None => error_services(conn, MERGE_ARMS + 1)?,
                    };
                    if services.is_empty() {
                        return Ok(());
                    }
                    if services.len() > MERGE_ARMS {
                        format!("{base} ORDER BY ts DESC")
                    } else {
                        let mut arms = Vec::with_capacity(services.len());
                        for s in services {
                            args.push(Value::Text(s));
                            arms.push(format!("{base} AND service = ?{}", args.len()));
                        }
                        // A compound ORDER BY merges the index-ordered arms without a sort.
                        format!("{} ORDER BY 2 DESC", arms.join(" UNION ALL "))
                    }
                } else {
                    match spec.services {
                        Some(s) => {
                            let mut marks = Vec::with_capacity(s.len());
                            for svc in s {
                                args.push(Value::Text(svc.clone()));
                                marks.push(format!("?{}", args.len()));
                            }
                            format!("{base} AND service IN ({})", marks.join(", "))
                        }
                        None => base,
                    }
                };
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(rusqlite::params_from_iter(args.iter()))?;
                while let Some(r) = rows.next()? {
                    if scan.rows >= spec.cap {
                        scan.truncated = true;
                        stopped = true;
                        break;
                    }
                    scan.rows += 1;
                    if !f(err_row(r, &day)?) {
                        stopped = true;
                        break;
                    }
                }
                Ok(())
            })?;
            if res.is_none() {
                scan.truncated = true;
                break;
            }
        }
        Ok(scan)
    }

    /// Error rows of one evidence `kind` (`crash` or `run`) in `[start, end]`, newest first,
    /// at most `limit`; the flag is true when there were more.
    pub fn evidence_errors(
        &self,
        kind: &str,
        start: i64,
        end: i64,
        service: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<ErrRow>, bool), QueryError> {
        let Some(entry) = self.snap.evidence.clone() else {
            return Ok((Vec::new(), false));
        };
        if entry.rows <= 0 {
            return Ok((Vec::new(), false));
        }
        let sql = format!(
            "SELECT {} FROM events WHERE err = 1 AND kind = ?1 AND ts BETWEEN ?2 AND ?3
             AND (?4 IS NULL OR service = ?4) ORDER BY ts DESC, id DESC LIMIT ?5",
            err_columns()
        );
        let got = self.on_file(&entry, self.deadline, |conn| {
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt
                .query_map(params![kind, start, end, service, limit as i64 + 1], |r| {
                    err_row(r, EVIDENCE_DAY)
                })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?;
        let mut rows = got.unwrap_or_default();
        let more = rows.len() > limit;
        rows.truncate(limit);
        Ok((rows, more))
    }

    pub fn event(&self, r: &EventRef) -> Result<Option<EventRow>, QueryError> {
        let Some(entry) = self.entry(&r.day).cloned() else {
            return Ok(None);
        };
        let sql = format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1");
        let row = self.on_file(&entry, self.deadline, |conn| {
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows =
                stmt.query_map(params![r.row_id], |row| event_row_from_sql(row, &entry.day))?;
            rows.next().transpose()
        })?;
        Ok(row.flatten())
    }

    /// Resource fields for an event's `res` id in its own file.
    pub fn resource(&self, ev: &EventRow) -> Result<Option<ResourceInfo>, QueryError> {
        let (Some(res), Some(entry)) = (ev.res, self.entry(&ev.day).cloned()) else {
            return Ok(None);
        };
        let row = self.on_file(&entry, self.deadline, |conn| {
            let mut stmt =
                conn.prepare_cached("SELECT host, version, pid FROM resources WHERE id = ?1")?;
            let mut rows = stmt.query_map(params![res], |r| {
                Ok(ResourceInfo {
                    host: r.get(0)?,
                    version: r.get(1)?,
                    pid: r.get(2)?,
                })
            })?;
            rows.next().transpose()
        })?;
        Ok(row.flatten())
    }

    /// Newest `k` event rows matching `sql` over the files overlapping `[start, end]`,
    /// returned oldest first. Files are read by descending `max_ts` and the read stops once
    /// `k` rows are held and the next file's `max_ts` is older than the `k`-th newest: the
    /// merge rule of `docs/engine.md` §4. `sql` must select [`EVENT_COLUMNS`] newest first
    /// with a `LIMIT` above `k`; `bind` runs it.
    fn newest_rows(
        &self,
        start: i64,
        end: i64,
        k: usize,
        sql: &str,
        bind: impl Fn(
            &mut rusqlite::Statement<'_>,
            &str,
            usize,
        ) -> rusqlite::Result<(Vec<EventRow>, bool)>,
    ) -> Result<(Vec<EventRow>, bool), QueryError> {
        let mut held: Vec<EventRow> = Vec::new();
        let mut more = false;
        for entry in self.files(start, end) {
            let kth = k.checked_sub(1).and_then(|i| held.get(i)).map(|r| r.ts);
            if kth.is_some_and(|t| entry.max_ts.is_some_and(|m| m < t)) {
                more = true;
                break;
            }
            let used: usize = held.iter().map(EventRow::estimated_bytes).sum();
            let budget = ROW_BYTES.saturating_sub(used);
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(sql)?;
                bind(&mut stmt, &entry.day, budget)
            })?;
            let Some((rows, cut)) = got else {
                more = true;
                break;
            };
            more |= cut;
            held.extend(rows);
            held.sort_by(newest_first);
            if held.len() > k {
                held.truncate(k);
                more = true;
            }
            if budget == 0 {
                more = true;
                break;
            }
        }
        held.reverse();
        Ok((held, more))
    }

    /// Events in `[start, end]`, optionally one service and pid, oldest first: the newest
    /// `limit` when `newest`, else the oldest.
    pub fn events_between(
        &self,
        start: i64,
        end: i64,
        service: Option<&str>,
        pid: Option<i64>,
        limit: usize,
        newest: bool,
    ) -> Result<(Vec<EventRow>, bool), QueryError> {
        let cols = EVENT_COLUMNS
            .split(", ")
            .map(|c| {
                let c = c.trim();
                if c.starts_with("json(") {
                    "json(e.attrs)".to_owned()
                } else {
                    format!("e.{c}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut sql = format!("SELECT {cols} FROM events e");
        let mut args: Vec<Value> = vec![Value::Integer(start), Value::Integer(end)];
        if let Some(p) = pid {
            args.push(Value::Integer(p));
            sql.push_str(&format!(
                " JOIN resources r ON r.id = e.res AND r.pid = ?{}",
                args.len()
            ));
        }
        sql.push_str(" WHERE e.ts BETWEEN ?1 AND ?2");
        if let Some(s) = service {
            args.push(Value::Text(s.to_owned()));
            sql.push_str(&format!(" AND e.service = ?{}", args.len()));
        }
        let order = if newest { "DESC" } else { "ASC" };
        sql.push_str(&format!(
            " ORDER BY e.ts {order}, e.id {order} LIMIT {}",
            limit + 1
        ));
        let bind = |stmt: &mut rusqlite::Statement<'_>, day: &str, budget: usize| {
            let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
                event_row_from_sql(r, day)
            })?;
            collect_rows_bounded(rows, day, limit + 1, budget)
        };
        if newest {
            return self.newest_rows(start, end, limit, &sql, bind);
        }
        let mut all: Vec<EventRow> = Vec::new();
        let mut more = false;
        for entry in self.files(start, end) {
            let used: usize = all.iter().map(EventRow::estimated_bytes).sum();
            let budget = ROW_BYTES.saturating_sub(used);
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                bind(&mut stmt, &entry.day, budget)
            })?;
            let Some((rows, cut)) = got else {
                more = true;
                break;
            };
            more |= cut;
            all.extend(rows);
            sort_events(&mut all);
            if all.len() > limit {
                all.truncate(limit);
                more = true;
            }
        }
        Ok((all, more))
    }

    /// Events of one trace across 14 days plus evidence, oldest first and deduplicated by
    /// span id, within [`TRACE_ROWS`] and [`ROW_BYTES`].
    pub fn trace(&self, trace_id: &[u8; 16]) -> Result<(Vec<EventRow>, bool), QueryError> {
        let start = self.now - 14 * NS_PER_DAY;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE trace_id = ?1 ORDER BY ts LIMIT {}",
            TRACE_ROWS + 1
        );
        let mut all = Vec::new();
        let mut more = false;
        // A trace may hold late events outside any window: read every file with rows.
        for entry in self.snap.all_non_empty_files(true) {
            if entry.max_ts.is_some_and(|m| m < start) {
                continue;
            }
            let used: usize = all.iter().map(EventRow::estimated_bytes).sum();
            let budget = ROW_BYTES.saturating_sub(used);
            if budget == 0 {
                more = true;
                break;
            }
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt.query_map(params![&trace_id[..]], |r| {
                    event_row_from_sql(r, &entry.day)
                })?;
                collect_rows_bounded(rows, &entry.day, TRACE_ROWS + 1, budget)
            })?;
            let Some((rows, cut)) = got else {
                more = true;
                break;
            };
            more |= cut;
            all.extend(rows);
            sort_events(&mut all);
            if all.len() > TRACE_ROWS {
                all.truncate(TRACE_ROWS);
                more = true;
            }
        }
        let mut seen = HashSet::new();
        all.retain(|r| {
            r.kind != motel_store::EventKind::Span || r.span_id.is_none_or(|s| seen.insert(s))
        });
        Ok((all, more))
    }

    /// The span with this id, newest files first. Spans are not indexed by id, so this reads
    /// whole files; it stops at the first hit or at a 2 s budget.
    pub fn find_span(&self, span_id: &[u8; 8]) -> Result<(Option<EventRow>, bool), QueryError> {
        let start = self.now - 14 * NS_PER_DAY;
        let deadline = Instant::now() + Duration::from_secs(2);
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE span_id = ?1 AND kind = 'span' LIMIT 1"
        );
        for entry in self.files(start, self.now) {
            let got = self.on_file(&entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows =
                    stmt.query_map(params![&span_id[..]], |r| event_row_from_sql(r, &entry.day))?;
                rows.next().transpose()
            })?;
            match got {
                None => return Ok((None, true)),
                Some(Some(row)) => return Ok((Some(row), false)),
                Some(None) => {}
            }
        }
        Ok((None, false))
    }

    /// Rows with `session_id` or `request_id` = `value` (column chosen by `by_request`),
    /// the newest `limit` over 14 days by the merge rule, returned oldest first.
    pub fn by_key(
        &self,
        value: &str,
        by_request: bool,
        limit: usize,
    ) -> Result<(Vec<EventRow>, bool), QueryError> {
        let col = if by_request {
            "request_id"
        } else {
            "session_id"
        };
        let start = self.now - 14 * NS_PER_DAY;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE {col} = ?1 AND ts >= ?2
             ORDER BY ts DESC, id DESC LIMIT {}",
            limit + 1
        );
        self.newest_rows(start, i64::MAX, limit, &sql, |stmt, day, budget| {
            let rows = stmt.query_map(params![value, start], |r| event_row_from_sql(r, day))?;
            collect_rows_bounded(rows, day, limit + 1, budget)
        })
    }

    /// Run rows (`kind = 'run'`) from evidence: one by row id, or the latest.
    pub fn run(&self, row_id: Option<i64>) -> Result<Option<EventRow>, QueryError> {
        let Some(entry) = self.snap.evidence.clone() else {
            return Ok(None);
        };
        let sql = match row_id {
            Some(_) => format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1 AND kind = 'run'"),
            None => format!(
                "SELECT {EVENT_COLUMNS} FROM events WHERE kind = 'run' AND ?1 IS NULL
                 ORDER BY ts DESC, id DESC LIMIT 1"
            ),
        };
        let got = self.on_file(&entry, self.deadline, |conn| {
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows =
                stmt.query_map(params![row_id], |r| event_row_from_sql(r, &entry.day))?;
            rows.next().transpose()
        })?;
        Ok(got.flatten())
    }

    /// Evidence rows of `kind` in `[start, end]`, oldest first.
    pub fn evidence_rows(
        &self,
        kind: &str,
        start: i64,
        end: i64,
        only_errors: bool,
        limit: usize,
    ) -> Result<Vec<EventRow>, QueryError> {
        let Some(entry) = self.snap.evidence.clone() else {
            return Ok(Vec::new());
        };
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE kind = ?1 AND ts BETWEEN ?2 AND ?3
             AND (?4 = 0 OR err = 1) ORDER BY ts, id LIMIT ?5"
        );
        let got = self.on_file(&entry, self.deadline, |conn| {
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map(
                params![kind, start, end, only_errors as i64, limit as i64],
                |r| event_row_from_sql(r, &entry.day),
            )?;
            collect_rows_bounded(rows, &entry.day, limit, ROW_BYTES).map(|(rows, _)| rows)
        })?;
        Ok(got.unwrap_or_default())
    }

    /// Number of evidence rows of `kind` in `[start, end]`.
    pub fn evidence_count(
        &self,
        kind: &str,
        start: i64,
        end: i64,
        only_errors: bool,
    ) -> Result<usize, QueryError> {
        let Some(entry) = self.snap.evidence.clone() else {
            return Ok(0);
        };
        let got = self.on_file(&entry, self.deadline, |conn| {
            conn.query_row(
                "SELECT count(*) FROM events WHERE kind = ?1 AND ts BETWEEN ?2 AND ?3
                 AND (?4 = 0 OR err = 1)",
                params![kind, start, end, only_errors as i64],
                |r| r.get::<_, i64>(0),
            )
        })?;
        Ok(got.unwrap_or(0).max(0) as usize)
    }

    /// Up to `k` slowest spans in `[start, end]` (all services), slowest first.
    pub fn slowest_spans(
        &self,
        start: i64,
        end: i64,
        k: usize,
    ) -> Result<Vec<EventRow>, QueryError> {
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE ts BETWEEN ?1 AND ?2 AND kind = 'span'
             AND dur IS NOT NULL ORDER BY dur DESC LIMIT ?3"
        );
        let mut all = Vec::new();
        for entry in self.files(start, end) {
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt.query_map(params![start, end, k as i64], |r| {
                    event_row_from_sql(r, &entry.day)
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            all.extend(got.unwrap_or_default());
            all.sort_by(|a, b| b.dur.cmp(&a.dur).then(a.ts.cmp(&b.ts)));
            all.truncate(k);
        }
        Ok(all)
    }

    /// Median duration of the newest (up to 200) `service`/`name` spans in `[start, end]`,
    /// by the merge rule. `None` when there are none or the 300 ms budget runs out first.
    pub fn p50(
        &self,
        service: &str,
        name: &str,
        start: i64,
        end: i64,
    ) -> Result<Option<i64>, QueryError> {
        const K: usize = 200;
        let deadline = Instant::now() + Duration::from_millis(300);
        let sql = "SELECT ts, dur FROM events WHERE service = ?1 AND ts BETWEEN ?2 AND ?3
                   AND kind = 'span' AND name = ?4 AND dur IS NOT NULL ORDER BY ts DESC LIMIT 200";
        // (ts, dur), newest first.
        let mut held: Vec<(i64, i64)> = Vec::new();
        for entry in self.files(start, end) {
            let kth = held.get(K - 1).map(|h| h.0);
            if kth.is_some_and(|t| entry.max_ts.is_some_and(|m| m < t)) {
                break;
            }
            let got = self.on_file(&entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(sql)?;
                let rows = stmt.query_map(params![service, start, end, name], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            let Some(rows) = got else {
                return Ok(None);
            };
            held.extend(rows);
            held.sort_by_key(|h| std::cmp::Reverse(h.0));
            held.truncate(K);
        }
        if held.is_empty() {
            return Ok(None);
        }
        let mut durs: Vec<i64> = held.into_iter().map(|(_, d)| d).collect();
        durs.sort_unstable();
        Ok(Some(durs[durs.len() / 2]))
    }

    /// Newest event time for `service`, across every file. A probe: not part of `searched`.
    pub fn service_last_ts(&self, service: &str) -> Result<Option<i64>, QueryError> {
        let mut best: Option<i64> = None;
        for entry in self.snap.all_non_empty_files(true) {
            if best.is_some_and(|b| entry.max_ts.is_some_and(|m| m < b)) {
                break;
            }
            let got = self.probe_file(&entry, |conn| {
                conn.query_row(
                    "SELECT max(ts) FROM events WHERE service = ?1",
                    params![service],
                    |r| r.get::<_, Option<i64>>(0),
                )
            })?;
            if let Some(Some(ts)) = got {
                best = Some(best.map_or(ts, |b| b.max(ts)));
            }
        }
        Ok(best)
    }

    /// Newest event of any service: `(ts, service)`. A probe: not part of `searched`.
    pub fn last_event(&self) -> Result<Option<(i64, String)>, QueryError> {
        let mut best: Option<(i64, String)> = None;
        for entry in self.snap.all_non_empty_files(true) {
            if best
                .as_ref()
                .is_some_and(|b| entry.max_ts.is_some_and(|m| m < b.0))
            {
                break;
            }
            let got = self.probe_file(&entry, |conn| {
                let mut stmt =
                    conn.prepare_cached("SELECT ts, service FROM events ORDER BY ts DESC LIMIT 1")?;
                let mut rows =
                    stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                rows.next().transpose()
            })?;
            if let Some(Some(row)) = got {
                if best.as_ref().is_none_or(|b| row.0 > b.0) {
                    best = Some(row);
                }
            }
        }
        Ok(best)
    }

    /// Services with events in `[start, end]`: `(name, events, last ts)`, busiest first.
    /// Distinct names come from a skip-scan of `ix_svc_ts`, counts from index ranges.
    pub fn services(&self, start: i64, end: i64) -> Result<Vec<(String, u64, i64)>, QueryError> {
        let mut acc: std::collections::BTreeMap<String, (u64, i64)> = Default::default();
        for entry in self.files(start, end) {
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut out = Vec::new();
                let mut next: Option<String> =
                    conn.query_row("SELECT min(service) FROM events", [], |r| r.get(0))?;
                while let Some(svc) = next {
                    let (n, last): (i64, Option<i64>) = conn.query_row(
                        "SELECT count(*), max(ts) FROM events WHERE service = ?1 AND ts BETWEEN ?2 AND ?3",
                        params![svc, start, end],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    if n > 0 {
                        out.push((svc.clone(), n as u64, last.unwrap_or(0)));
                    }
                    next = conn.query_row(
                        "SELECT min(service) FROM events WHERE service > ?1",
                        params![svc],
                        |r| r.get(0),
                    )?;
                }
                Ok(out)
            })?;
            for (svc, n, last) in got.unwrap_or_default() {
                let e = acc.entry(svc).or_insert((0, i64::MIN));
                e.0 += n;
                e.1 = e.1.max(last);
            }
        }
        let mut out: Vec<(String, u64, i64)> =
            acc.into_iter().map(|(s, (n, l))| (s, n, l)).collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(out)
    }
}

/// Up to `max` distinct services with error rows in this file, by a skip-scan of `ix_err`.
fn error_services(conn: &rusqlite::Connection, max: usize) -> rusqlite::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut first = conn.prepare_cached(
        "SELECT service FROM events INDEXED BY ix_err WHERE err = 1 ORDER BY service LIMIT 1",
    )?;
    let mut next = first
        .query_map([], |r| r.get::<_, String>(0))?
        .next()
        .transpose()?;
    let mut after = conn.prepare_cached(
        "SELECT service FROM events INDEXED BY ix_err WHERE err = 1 AND service > ?1
         ORDER BY service LIMIT 1",
    )?;
    while let Some(s) = next {
        if out.len() >= max {
            break;
        }
        next = after
            .query_map(params![s], |r| r.get::<_, String>(0))?
            .next()
            .transpose()?;
        out.push(s);
    }
    Ok(out)
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ResourceInfo {
    pub host: Option<String>,
    pub version: Option<String>,
    pub pid: Option<i64>,
}

pub(crate) fn sort_events(rows: &mut [EventRow]) {
    rows.sort_by(|a, b| {
        a.ts.cmp(&b.ts)
            .then_with(|| a.day.cmp(&b.day))
            .then_with(|| a.row_id.cmp(&b.row_id))
    });
}

fn newest_first(a: &EventRow, b: &EventRow) -> std::cmp::Ordering {
    b.ts.cmp(&a.ts)
        .then_with(|| b.day.cmp(&a.day))
        .then_with(|| b.row_id.cmp(&a.row_id))
}

/// The message an error row is grouped by, from a full event row ([`group_message`]).
pub(crate) fn event_message(ev: &EventRow) -> String {
    group_message(ev.body.as_deref(), ev.attrs.as_deref())
}

/// The `g:` id an error event belongs to, or `None` for kinds that are not grouped.
pub(crate) fn event_group_id(ev: &EventRow) -> Option<String> {
    (ev.err && is_group_kind(ev.kind.as_str())).then(|| {
        crate::fingerprint::group_id(crate::fingerprint::fingerprint(
            &ev.service,
            ev.kind.as_str(),
            ev.name.as_deref(),
            &event_message(ev),
        ))
    })
}

/// Attribute lookup on an event's JSON attrs.
pub(crate) fn attr(ev: &EventRow, key: &str) -> Option<serde_json::Value> {
    let attrs = ev.attrs.as_deref()?;
    match serde_json::from_str::<serde_json::Value>(attrs).ok()? {
        serde_json::Value::Object(mut m) => m.remove(key),
        _ => None,
    }
}

pub(crate) fn attr_str(ev: &EventRow, key: &str) -> Option<String> {
    match attr(ev, key)? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Null => None,
        v => Some(v.to_string()),
    }
}

/// True for rows `why` reports as error groups (crashes and runs have their own findings;
/// failed tests are shown under their run).
pub(crate) fn is_group_kind(kind: &str) -> bool {
    !matches!(kind, "crash" | "run" | "test")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::{log, seeded, seeded_with, span, trace, Row, D, H, M, MS, NOW, S};
    use crate::searched::CUT_SHORT_NOTE;

    #[test]
    fn a_spent_deadline_is_reported_not_swallowed() {
        let f = seeded("data-deadline");
        let q = f.query();
        let mut ctx = Ctx::new(&q);
        ctx.deadline = Instant::now();
        let (rows, more) = ctx
            .events_between(NOW - D, NOW, None, None, 10, true)
            .unwrap();
        assert!(rows.is_empty() && more);
        let s = ctx.searched(NOW - D, NOW);
        assert!(s.truncated);
        assert!(s.notes.iter().any(|n| n == CUT_SHORT_NOTE));
        assert!(s.line().contains("time budget"));
    }

    #[test]
    fn probes_are_not_searched_days() {
        let f = seeded("data-probe");
        let q = f.query();
        let ctx = Ctx::new(&q);
        assert!(ctx.service_last_ts("cron").unwrap().is_some());
        assert!(ctx.last_event().unwrap().is_some());
        assert!(ctx.visited.borrow().0.is_empty());
    }

    #[test]
    fn by_key_and_p50_keep_the_newest_across_files() {
        let session = |ts: i64, arrive: i64, body: &str| {
            let mut e = log(ts, "svc", 9, body);
            e.session_id = Some("s1".to_owned());
            Row { arrive, ev: e }
        };
        let mut rows = vec![
            session(NOW - 3 * D, NOW - 3 * D, "row 0"),
            session(NOW - 2 * D, NOW - 2 * D, "row 1"),
            session(NOW - D, NOW - D, "row 2"),
            session(NOW - H, NOW - H, "row 3"),
            // Stamped 2.5 days ago, arriving in today's file.
            session(NOW - 2 * D - 12 * H, NOW - 30 * M, "late"),
        ];
        // 300 older fast spans, then 200 newer slow ones.
        for i in 0..300 {
            let ts = NOW - 5 * D + i * S;
            let ev = span(ts, "svc", "op", 10 * MS, trace(1), 1000 + i as u64, None);
            rows.push(Row { arrive: ts, ev });
        }
        for i in 0..200 {
            let ts = NOW - 2 * D + H + i * S;
            let ev = span(ts, "svc", "op", 100 * MS, trace(2), 5000 + i as u64, None);
            rows.push(Row { arrive: ts, ev });
        }
        let f = seeded_with("data-merge", rows);
        let q = f.query();
        let ctx = Ctx::new(&q);
        let (got, more) = ctx.by_key("s1", false, 3).unwrap();
        assert!(more);
        let bodies: Vec<&str> = got.iter().filter_map(|r| r.body.as_deref()).collect();
        assert_eq!(bodies, ["row 1", "row 2", "row 3"]);
        assert_eq!(
            ctx.p50("svc", "op", NOW - 7 * D, NOW).unwrap(),
            Some(100 * MS)
        );
    }
}
