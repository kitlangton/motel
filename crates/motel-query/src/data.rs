//! Per-call store access built on motel-store's reader primitives.
//!
//! A [`Ctx`] holds one catalog snapshot, the call's clock reading, its deadline and the set
//! of files it touched, so every answer can report exactly what it searched.

use std::cell::RefCell;
use std::collections::HashSet;
use std::time::{Duration, Instant};

use motel_store::{
    event_row_from_sql, Catalog, CatalogEntry, EventRow, StoreError, EVENT_COLUMNS, NS_PER_DAY,
};
use rusqlite::params;
use rusqlite::types::Value;

use crate::ids::{EventRef, EVIDENCE_DAY};
use crate::searched::Visited;
use crate::time::Tz;
use crate::{Query, QueryError};

/// Budget for one `why` or `show` call.
const CALL_BUDGET: Duration = Duration::from_secs(5);

/// The message used for error grouping: the body, else an exception/status attribute.
const MSG_COLUMNS: &str = "substr(body, 1, 512),
    CASE WHEN body IS NULL OR body = '' THEN CAST(coalesce(
        attr(attrs, 'exception.message'), attr(attrs, 'error.message'),
        attr(attrs, 'exception.type'), attr(attrs, 'otel.status_description'),
        attr(attrs, 'status.message')) AS TEXT) END";

/// An error row projected for grouping.
#[derive(Debug, Clone)]
pub(crate) struct ErrRow {
    pub ev: EventRef,
    pub ts: i64,
    pub kind: String,
    pub service: String,
    pub name: Option<String>,
    pub msg: String,
    pub trace_id: Option<[u8; 16]>,
}

/// How a bounded scan ended.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Scan {
    pub rows: usize,
    /// Stopped by the row cap or the deadline before reading everything.
    pub truncated: bool,
}

pub(crate) struct Ctx<'q> {
    pub q: &'q Query,
    pub snap: Catalog,
    pub now: i64,
    pub tz: Tz,
    pub deadline: Instant,
    pub visited: RefCell<Visited>,
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

    /// Run `f` on one file, recording the visit. A deadline hit returns `Ok(None)`.
    fn on_file<T>(
        &self,
        entry: &CatalogEntry,
        deadline: Instant,
        f: impl FnMut(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<Option<T>, QueryError> {
        self.visited.borrow_mut().add(&entry.day);
        let deadline = deadline.min(self.deadline);
        if Instant::now() >= deadline {
            return Ok(None);
        }
        match self.q.reader.query_file(entry, deadline, f) {
            Ok(v) => Ok(Some(v)),
            Err(StoreError::QueryDeadlineExceeded) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Error rows in `[start, end]`, newest first within each file, through the `ix_err`
    /// partial index. `f` returns false to stop early.
    #[allow(clippy::too_many_arguments)]
    pub fn scan_errors(
        &self,
        start: i64,
        end: i64,
        service: Option<&str>,
        kind_name: Option<(&str, Option<&str>)>,
        cap: usize,
        deadline: Instant,
        mut f: impl FnMut(ErrRow) -> bool,
    ) -> Result<Scan, QueryError> {
        let mut sql = format!(
            "SELECT id, ts, kind, service, name, {MSG_COLUMNS}, trace_id
             FROM events INDEXED BY ix_err
             WHERE err = 1 AND ts BETWEEN ?1 AND ?2"
        );
        let mut args: Vec<Value> = vec![Value::Integer(start), Value::Integer(end)];
        if let Some(s) = service {
            args.push(Value::Text(s.to_owned()));
            sql.push_str(&format!(" AND service = ?{}", args.len()));
        }
        if let Some((kind, name)) = kind_name {
            args.push(Value::Text(kind.to_owned()));
            sql.push_str(&format!(" AND kind = ?{}", args.len()));
            args.push(name.map_or(Value::Null, |n| Value::Text(n.to_owned())));
            sql.push_str(&format!(" AND name IS ?{}", args.len()));
        }
        sql.push_str(" ORDER BY ts DESC");

        let mut scan = Scan::default();
        let mut stopped = false;
        for entry in self.files(start, end) {
            if stopped {
                break;
            }
            let day = entry.day.clone();
            let res = self.on_file(&entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(rusqlite::params_from_iter(args.iter()))?;
                while let Some(r) = rows.next()? {
                    if scan.rows >= cap {
                        scan.truncated = true;
                        stopped = true;
                        break;
                    }
                    scan.rows += 1;
                    let body: Option<String> = r.get(5)?;
                    let alt: Option<String> = r.get(6)?;
                    let trace: Option<Vec<u8>> = r.get(7)?;
                    let row = ErrRow {
                        ev: EventRef::new(&day, r.get(0)?),
                        ts: r.get(1)?,
                        kind: r.get(2)?,
                        service: r.get(3)?,
                        name: r.get(4)?,
                        msg: body
                            .filter(|b| !b.trim().is_empty())
                            .or(alt)
                            .unwrap_or_default(),
                        trace_id: trace.and_then(|b| b.try_into().ok()),
                    };
                    if !f(row) {
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

    /// Events in `[start, end]`, optionally one service and pid, merged across files in time
    /// order. Keeps the newest `limit` when `newest`, else the oldest.
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

        let mut all = Vec::new();
        for entry in self.files(start, end) {
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
                    event_row_from_sql(r, &entry.day)
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            all.extend(got.unwrap_or_default());
        }
        sort_events(&mut all);
        let more = all.len() > limit;
        if newest {
            let skip = all.len().saturating_sub(limit);
            all.drain(..skip);
        } else {
            all.truncate(limit);
        }
        Ok((all, more))
    }

    /// Events of one trace across 14 days plus evidence, deduplicated by span id.
    pub fn trace(&self, trace_id: &[u8; 16]) -> Result<(Vec<EventRow>, bool), QueryError> {
        let start = self.now - 14 * NS_PER_DAY;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE trace_id = ?1 ORDER BY ts LIMIT 5001"
        );
        let mut all = Vec::new();
        // A trace may hold late events outside any window: read every file with rows.
        for entry in self.snap.all_non_empty_files(true) {
            if entry.max_ts.is_some_and(|m| m < start) {
                continue;
            }
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt.query_map(params![&trace_id[..]], |r| {
                    event_row_from_sql(r, &entry.day)
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            all.extend(got.unwrap_or_default());
        }
        sort_events(&mut all);
        let mut seen = HashSet::new();
        all.retain(|r| {
            r.kind != motel_store::EventKind::Span || r.span_id.is_none_or(|s| seen.insert(s))
        });
        let more = all.len() > 5000;
        all.truncate(5000);
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
    /// newest `limit` over 14 days, returned oldest first.
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
            "SELECT {EVENT_COLUMNS} FROM events WHERE {col} = ?1 AND ts BETWEEN ?2 AND ?3
             ORDER BY ts DESC LIMIT {}",
            limit + 1
        );
        let mut all = Vec::new();
        for entry in self.files(start, i64::MAX) {
            let got = self.on_file(&entry, self.deadline, |conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt.query_map(params![value, start, i64::MAX], |r| {
                    event_row_from_sql(r, &entry.day)
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            all.extend(got.unwrap_or_default());
        }
        sort_events(&mut all);
        let more = all.len() > limit;
        let skip = all.len().saturating_sub(limit);
        all.drain(..skip);
        Ok((all, more))
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
            rows.collect::<Result<Vec<_>, _>>()
        })?;
        Ok(got.unwrap_or_default())
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
        }
        all.sort_by(|a, b| b.dur.cmp(&a.dur).then(a.ts.cmp(&b.ts)));
        all.truncate(k);
        Ok(all)
    }

    /// Median duration of the newest (up to 200) `service`/`name` spans in `[start, end]`.
    /// `None` when there are none or the 300 ms budget runs out first.
    pub fn p50(
        &self,
        service: &str,
        name: &str,
        start: i64,
        end: i64,
    ) -> Result<Option<i64>, QueryError> {
        let deadline = Instant::now() + Duration::from_millis(300);
        let sql = "SELECT dur FROM events WHERE service = ?1 AND ts BETWEEN ?2 AND ?3
                   AND kind = 'span' AND name = ?4 AND dur IS NOT NULL ORDER BY ts DESC LIMIT 200";
        let mut durs: Vec<i64> = Vec::new();
        for entry in self.files(start, end) {
            if durs.len() >= 200 {
                break;
            }
            let got = self.on_file(&entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(sql)?;
                let rows =
                    stmt.query_map(params![service, start, end, name], |r| r.get::<_, i64>(0))?;
                rows.collect::<Result<Vec<_>, _>>()
            })?;
            match got {
                Some(d) => durs.extend(d),
                None => break,
            }
        }
        if durs.is_empty() {
            return Ok(None);
        }
        durs.sort_unstable();
        Ok(Some(durs[durs.len() / 2]))
    }

    /// Newest event time for `service`, across every file.
    pub fn service_last_ts(&self, service: &str) -> Result<Option<i64>, QueryError> {
        let mut best: Option<i64> = None;
        for entry in self.snap.all_non_empty_files(true) {
            if best.is_some_and(|b| entry.max_ts.is_some_and(|m| m < b)) {
                break;
            }
            let got = self.on_file(&entry, self.deadline, |conn| {
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

    /// Newest event of any service: `(ts, service)`.
    pub fn last_event(&self) -> Result<Option<(i64, String)>, QueryError> {
        let mut best: Option<(i64, String)> = None;
        for entry in self.snap.all_non_empty_files(true) {
            if best
                .as_ref()
                .is_some_and(|b| entry.max_ts.is_some_and(|m| m < b.0))
            {
                break;
            }
            let got = self.on_file(&entry, self.deadline, |conn| {
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

/// The message an error row is grouped by, from a full event row.
pub(crate) fn event_message(ev: &EventRow) -> String {
    if let Some(b) = ev.body.as_deref().filter(|b| !b.trim().is_empty()) {
        return b.to_owned();
    }
    let Some(attrs) = ev.attrs.as_deref() else {
        return String::new();
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(attrs)
    else {
        return String::new();
    };
    for key in [
        "exception.message",
        "error.message",
        "exception.type",
        "otel.status_description",
        "status.message",
    ] {
        match map.get(key) {
            Some(serde_json::Value::String(s)) => return s.clone(),
            Some(v) if !v.is_null() => return v.to_string(),
            _ => {}
        }
    }
    String::new()
}

/// The `g:` id an error event belongs to.
pub(crate) fn event_group_id(ev: &EventRow) -> String {
    crate::fingerprint::group_id(crate::fingerprint::fingerprint(
        &ev.service,
        ev.kind.as_str(),
        ev.name.as_deref(),
        &event_message(ev),
    ))
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
