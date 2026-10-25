use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, InterruptHandle, OpenFlags, Row};

use crate::catalog::{Catalog, CatalogEntry, NS_PER_DAY, NS_PER_HOUR, NS_PER_MINUTE};
use crate::schema::{
    configure_reader_conn, configure_reader_limits, ensure_sqlite_environment, sqlite_file_uri,
};
use crate::{
    Clock, EventKind, EventRow, EventSource, QueryMeta, QueryResult, SqlRow, SqlTable, SqlValue,
    StoreError, SystemClock, TimeWindow,
};

/// Column list that [`event_row_from_sql`] expects, in order, for `SELECT ... FROM events`.
pub const EVENT_COLUMNS: &str = "id, ts, ingest_ts, dur, kind, service, severity, status, err, name, \
     trace_id, span_id, parent_id, session_id, request_id, res, src, artifact, body, json(attrs)";

/// Map a row selected with [`EVENT_COLUMNS`] from the file for `day` into an [`EventRow`].
pub fn event_row_from_sql(row: &Row<'_>, day: &str) -> rusqlite::Result<EventRow> {
    map_event_row_with_day(row, day)
}

/// Default query deadline: 2 seconds (engine.md §4).
pub const DEFAULT_QUERY_DEADLINE: Duration = Duration::from_secs(2);
/// Maximum query deadline: 10 seconds (engine.md §4).
pub const MAX_QUERY_DEADLINE: Duration = Duration::from_secs(10);
/// Default output row cap: 1,000 rows (engine.md §4).
pub const DEFAULT_MAX_ROWS: usize = 1_000;
/// Default output byte cap: 1 MiB (engine.md §4).
pub const DEFAULT_MAX_BYTES: usize = 1_048_576;
/// Reader connection pool capacity: 2 connections (engine.md §4).
pub const READER_POOL_CAPACITY: usize = 2;
/// Reader idle eviction timeout: 60 seconds (engine.md §4).
pub const READER_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

struct PooledConn {
    path: PathBuf,
    is_sealed: bool,
    conn: Connection,
    last_used: Instant,
}

/// Pool of up to 2 read connections, closed after 60 s idle (`docs/engine.md` §4).
/// Also tracks in-flight `sql()` interrupt handles so writer `SQLITE_NOMEM` recovery
/// can abort and reclaim memory from ad-hoc SQL connections (`docs/engine.md` §2.2, §9).
pub struct ReaderPool {
    conns: Mutex<Vec<PooledConn>>,
    active_sql: Mutex<Vec<(u64, InterruptHandle)>>,
    next_sql_id: AtomicU64,
}

impl Default for ReaderPool {
    fn default() -> Self {
        Self::new()
    }
}

impl ReaderPool {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(Vec::with_capacity(READER_POOL_CAPACITY)),
            active_sql: Mutex::new(Vec::new()),
            next_sql_id: AtomicU64::new(1),
        }
    }

    /// Evict all pooled reader connections and interrupt any active `sql()` connections
    /// (called on `SQLITE_NOMEM` or before sealing a file).
    pub fn close_all(&self) {
        self.conns.lock().unwrap().clear();
        let active = self.active_sql.lock().unwrap();
        for (_, handle) in active.iter() {
            handle.interrupt();
        }
    }

    fn register_sql_interrupt(&self, handle: InterruptHandle) -> u64 {
        let id = self.next_sql_id.fetch_add(1, Ordering::Relaxed);
        self.active_sql.lock().unwrap().push((id, handle));
        id
    }

    fn unregister_sql_interrupt(&self, id: u64) {
        self.active_sql.lock().unwrap().retain(|(entry_id, _)| *entry_id != id);
    }

    /// Evict connections idle for more than 60 seconds.
    pub fn evict_idle(&self) {
        let mut guard = self.conns.lock().unwrap();
        guard.retain(|c| c.last_used.elapsed() < READER_IDLE_TIMEOUT);
    }

    fn checkout(&self, path: &Path, is_sealed: bool) -> Result<Connection, StoreError> {
        {
            let mut guard = self.conns.lock().unwrap();
            guard.retain(|c| c.last_used.elapsed() < READER_IDLE_TIMEOUT);
            if let Some(idx) = guard
                .iter()
                .position(|c| c.path == path && c.is_sealed == is_sealed)
            {
                return Ok(guard.swap_remove(idx).conn);
            }
        }
        open_file_read_only(path, is_sealed)
    }

    fn checkin(&self, path: PathBuf, is_sealed: bool, mut conn: Connection) {
        let _ = conn.progress_handler(0, None::<fn() -> bool>);
        let _ = conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let mut guard = self.conns.lock().unwrap();
        guard.retain(|c| c.last_used.elapsed() < READER_IDLE_TIMEOUT);
        if guard.len() >= READER_POOL_CAPACITY {
            // Drop the oldest connection to stay within the 2-connection cap.
            if let Some((oldest_idx, _)) = guard
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| c.last_used)
            {
                guard.remove(oldest_idx);
            }
        }
        guard.push(PooledConn {
            path,
            is_sealed,
            conn,
            last_used: Instant::now(),
        });
    }
}

struct SqlInterruptGuard<'a> {
    pool: &'a ReaderPool,
    id: u64,
}

impl Drop for SqlInterruptGuard<'_> {
    fn drop(&mut self) {
        self.pool.unregister_sql_interrupt(self.id);
    }
}

fn open_file_read_only(path: &Path, is_sealed: bool) -> Result<Connection, StoreError> {
    let uri = sqlite_file_uri(path, is_sealed);
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&uri, flags)?;
    configure_reader_conn(&conn, 0)?;
    Ok(conn)
}

/// Reader handle supporting all query primitives and sandboxed ad-hoc SQL (engine.md §4).
#[derive(Clone)]
pub struct Reader {
    root_dir: PathBuf,
    catalog: Arc<RwLock<Catalog>>,
    pool: Arc<ReaderPool>,
    clock: Arc<dyn Clock>,
    default_deadline: Duration,
    read_only_cli_mode: bool,
}

impl Reader {
    pub(crate) fn new(
        root_dir: PathBuf,
        catalog: Arc<RwLock<Catalog>>,
        pool: Arc<ReaderPool>,
        clock: Arc<dyn Clock>,
        default_deadline: Duration,
        read_only_cli_mode: bool,
    ) -> Self {
        Self {
            root_dir,
            catalog,
            pool,
            clock,
            default_deadline: default_deadline.min(MAX_QUERY_DEADLINE),
            read_only_cli_mode,
        }
    }

    /// Open the store in daemonless read-only CLI mode (engine.md §4 last paragraph).
    /// Sealed files open `immutable=1`, hot files `mode=ro`; never writes or checkpoints;
    /// retries `SQLITE_BUSY` 3 times and reports staleness from `max_ingest_ts`.
    pub fn open_read_only(root_dir: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::open_read_only_with_clock(root_dir, Arc::new(SystemClock))
    }

    /// Open the store in daemonless read-only CLI mode with a custom clock.
    pub fn open_read_only_with_clock(
        root_dir: impl AsRef<Path>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, StoreError> {
        ensure_sqlite_environment()?;
        let root = root_dir.as_ref().to_path_buf();
        let catalog = retry_busy_cli(true, || Catalog::scan_dir(&root))?;
        Ok(Self::new(
            root,
            Arc::new(RwLock::new(catalog)),
            Arc::new(ReaderPool::new()),
            clock,
            DEFAULT_QUERY_DEADLINE,
            true,
        ))
    }

    /// Refresh the catalog from disk (used in read-only CLI mode or when external files change).
    pub fn refresh_catalog(&self) -> Result<(), StoreError> {
        let fresh = retry_busy_cli(self.read_only_cli_mode, || Catalog::scan_dir(&self.root_dir))?;
        *self.catalog.write().unwrap() = fresh;
        Ok(())
    }

    /// Return a clone of the current catalog snapshot.
    pub fn catalog_snapshot(&self) -> Catalog {
        if self.read_only_cli_mode {
            let _ = self.refresh_catalog();
        }
        self.catalog.read().unwrap().clone()
    }

    /// Return the staleness (`now_ns - max_ingest_ts`) in nanoseconds, if any events exist (§4).
    pub fn staleness_ns(&self) -> Option<i64> {
        let snap = self.catalog_snapshot();
        snap.max_ingest_ts()
            .map(|max_ing| self.clock.now_ns().saturating_sub(max_ing))
    }

    /// Return a copy of this `Reader` with a custom per-query deadline (clamped to 10 s max, §4).
    pub fn with_deadline(&self, deadline: Duration) -> Self {
        let mut r = self.clone();
        r.default_deadline = deadline.min(MAX_QUERY_DEADLINE);
        r
    }

    /// Current time from this reader's clock (Unix ns).
    pub fn now_ns(&self) -> i64 {
        self.clock.now_ns()
    }

    /// True when this reader reads the files directly in daemonless CLI mode.
    pub fn is_direct(&self) -> bool {
        self.read_only_cli_mode
    }

    /// The per-query deadline this reader applies (`docs/engine.md` §4).
    pub fn default_deadline(&self) -> Duration {
        self.default_deadline
    }

    /// Run trusted, read-only SQL against one catalog file on a pooled read connection with
    /// the progress-handler `deadline`. Higher-level query crates use this to build their own
    /// per-file scans; select [`EVENT_COLUMNS`] and map rows with [`event_row_from_sql`].
    pub fn query_file<T, F>(
        &self,
        entry: &CatalogEntry,
        deadline: Instant,
        f: F,
    ) -> Result<T, StoreError>
    where
        F: FnMut(&Connection) -> rusqlite::Result<T>,
    {
        self.query_single_file(entry, deadline, f)
    }

    /// Primitive 1: Recent errors for a service (engine.md §4).
    /// When `window` is `None`, searches the last 24 h first and walks back to 14 d if fewer
    /// than `limit` errors are found in 24 h. Uses the descending-`max_ts` merge rule (`docs/engine.md` §4).
    pub fn recent_errors(
        &self,
        service: &str,
        limit: usize,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        if let Some(win) = window {
            return self.run_descending_ts_merge(
                win,
                true,
                k,
                "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                        trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                        body, json(attrs)
                 FROM events
                 WHERE err = 1 AND service = ?1 AND ts BETWEEN ?2 AND ?3
                 ORDER BY ts DESC, id DESC
                 LIMIT ?4",
                |stmt, day, w0, w1, lim| {
                    let rows = stmt.query_map(params![service, w0, w1, lim as i64], map_event_row)?;
                    collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
                },
            );
        }

        // Default: 24 h, walks back to 14 d until K rows are collected (docs/engine.md §4).
        let now = self.clock.now_ns();
        let win_24h = TimeWindow::new(now.saturating_sub(24 * NS_PER_HOUR), now);
        let res_24h = self.run_descending_ts_merge(
            win_24h,
            true,
            k,
            "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                    body, json(attrs)
             FROM events
             WHERE err = 1 AND service = ?1 AND ts BETWEEN ?2 AND ?3
             ORDER BY ts DESC, id DESC
             LIMIT ?4",
            |stmt, day, w0, w1, lim| {
                let rows = stmt.query_map(params![service, w0, w1, lim as i64], map_event_row)?;
                collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
            },
        )?;
        if res_24h.rows.len() >= k {
            return Ok(res_24h);
        }

        let win_14d = TimeWindow::new(now.saturating_sub(14 * NS_PER_DAY), now);
        self.run_descending_ts_merge(
            win_14d,
            true,
            k,
            "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                    body, json(attrs)
             FROM events
             WHERE err = 1 AND service = ?1 AND ts BETWEEN ?2 AND ?3
             ORDER BY ts DESC, id DESC
             LIMIT ?4",
            |stmt, day, w0, w1, lim| {
                let rows = stmt.query_map(params![service, w0, w1, lim as i64], map_event_row)?;
                collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
            },
        )
    }

    /// Primitive 2: Events for a trace ID across 14 d plus `evidence.sqlite`, merged by `ts` ascending
    /// and deduplicated by `span_id` for spans (`docs/engine.md` §3.3, §4).
    pub fn by_trace_id(
        &self,
        trace_id: &[u8; 16],
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let now = self.clock.now_ns();
        let win = window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(14 * NS_PER_DAY), now));
        let snap = self.catalog_snapshot();
        let candidates = snap.candidates_by_max_ts_desc(win.start_ns, win.end_ns, true);

        let deadline = Instant::now() + self.default_deadline;
        let mut all_rows: Vec<EventRow> = Vec::new();
        let mut files_searched = 0usize;
        let mut any_file_truncated = false;

        for entry in &candidates {
            files_searched += 1;
            let (file_rows, file_trunc) = self.query_single_file(entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                            trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                            body, json(attrs)
                     FROM events
                     WHERE trace_id = ?1
                     ORDER BY ts ASC, id ASC
                     LIMIT ?2",
                )?;
                let iter = stmt.query_map(
                    params![&trace_id[..], (DEFAULT_MAX_ROWS + 1) as i64],
                    |r| map_event_row_with_day(r, &entry.day),
                )?;
                collect_rows_bounded(iter, &entry.day, DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES)
            })?;
            if file_trunc {
                any_file_truncated = true;
            }
            all_rows.extend(file_rows);
        }

        // Sort by ts ascending, then day, then row_id.
        all_rows.sort_by(|a, b| {
            a.ts.cmp(&b.ts)
                .then_with(|| a.day.cmp(&b.day))
                .then_with(|| a.row_id.cmp(&b.row_id))
        });

        // Dedupe span rows by span_id (docs/engine.md §3.3, §4).
        let mut seen_spans: HashSet<[u8; 8]> = HashSet::new();
        all_rows.retain(|r| {
            if r.kind == EventKind::Span {
                if let Some(sid) = r.span_id {
                    return seen_spans.insert(sid);
                }
            }
            true
        });

        let (rows, cap_truncated) = enforce_output_caps(all_rows, DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES);
        let truncated = any_file_truncated || cap_truncated;
        Ok(QueryResult {
            rows,
            meta: self.build_meta(&snap, win, files_searched, truncated),
        })
    }

    /// Primitive 3: Events by `session_id` (default 14 d), ordered by `ts DESC` using the merge rule (§4).
    pub fn by_session_id(
        &self,
        session_id: &str,
        limit: usize,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let now = self.clock.now_ns();
        let win = window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(14 * NS_PER_DAY), now));
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        self.run_descending_ts_merge(
            win,
            true,
            k,
            "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                    body, json(attrs)
             FROM events
             WHERE session_id = ?1 AND ts BETWEEN ?2 AND ?3
             ORDER BY ts DESC, id DESC
             LIMIT ?4",
            |stmt, day, w0, w1, lim| {
                let rows = stmt.query_map(params![session_id, w0, w1, lim as i64], map_event_row)?;
                collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
            },
        )
    }

    /// Primitive 4: Events by `request_id` (default 14 d), ordered by `ts DESC` using the merge rule (§4).
    pub fn by_request_id(
        &self,
        request_id: &str,
        limit: usize,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let now = self.clock.now_ns();
        let win = window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(14 * NS_PER_DAY), now));
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        self.run_descending_ts_merge(
            win,
            true,
            k,
            "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                    body, json(attrs)
             FROM events
             WHERE request_id = ?1 AND ts BETWEEN ?2 AND ?3
             ORDER BY ts DESC, id DESC
             LIMIT ?4",
            |stmt, day, w0, w1, lim| {
                let rows = stmt.query_map(params![request_id, w0, w1, lim as i64], map_event_row)?;
                collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
            },
        )
    }

    /// Primitive 5: Events around a timestamp (`±half_window_ns`, default ±2 min),
    /// optionally filtered by `service`, ordered by `ts ASC` (`docs/engine.md` §4).
    pub fn around_timestamp(
        &self,
        center_ts: i64,
        half_window_ns: Option<i64>,
        service: Option<&str>,
        limit: usize,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let half = half_window_ns.unwrap_or(2 * NS_PER_MINUTE);
        let win = TimeWindow::new(center_ts.saturating_sub(half), center_ts.saturating_add(half));
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        let snap = self.catalog_snapshot();
        let candidates = snap.candidates_by_max_ts_desc(win.start_ns, win.end_ns, true);
        let deadline = Instant::now() + self.default_deadline;

        let mut all_rows: Vec<EventRow> = Vec::new();
        let mut files_searched = 0usize;
        let mut any_file_truncated = false;

        for entry in &candidates {
            files_searched += 1;
            let (file_rows, file_trunc) = self.query_single_file(entry, deadline, |conn| {
                if let Some(svc) = service {
                    let mut stmt = conn.prepare_cached(
                        "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                                trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                                body, json(attrs)
                         FROM events
                         WHERE service = ?1 AND ts BETWEEN ?2 AND ?3
                         ORDER BY ts ASC, id ASC
                         LIMIT ?4",
                    )?;
                    let rows = stmt.query_map(
                        params![svc, win.start_ns, win.end_ns, (k + 1) as i64],
                        |r| map_event_row_with_day(r, &entry.day),
                    )?;
                    collect_rows_bounded(rows, &entry.day, k, DEFAULT_MAX_BYTES)
                } else {
                    let mut stmt = conn.prepare_cached(
                        "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                                trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                                body, json(attrs)
                         FROM events
                         WHERE ts BETWEEN ?1 AND ?2
                         ORDER BY ts ASC, id ASC
                         LIMIT ?3",
                    )?;
                    let rows = stmt.query_map(
                        params![win.start_ns, win.end_ns, (k + 1) as i64],
                        |r| map_event_row_with_day(r, &entry.day),
                    )?;
                    collect_rows_bounded(rows, &entry.day, k, DEFAULT_MAX_BYTES)
                }
            })?;
            if file_trunc {
                any_file_truncated = true;
            }
            all_rows.extend(file_rows);
        }

        all_rows.sort_by(|a, b| {
            a.ts.cmp(&b.ts)
                .then_with(|| a.day.cmp(&b.day))
                .then_with(|| a.row_id.cmp(&b.row_id))
        });

        let (rows, cap_truncated) = enforce_output_caps(all_rows, k, DEFAULT_MAX_BYTES);
        let truncated = any_file_truncated || cap_truncated;
        Ok(QueryResult {
            rows,
            meta: self.build_meta(&snap, win, files_searched, truncated),
        })
    }

    /// Primitive 6: Body substring search (default 24 h), newest arrival first (`ORDER BY id DESC`),
    /// default limit 50 (`docs/engine.md` §4).
    pub fn body_substring(
        &self,
        needle: &str,
        service: Option<&str>,
        limit: usize,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let now = self.clock.now_ns();
        let win = window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(24 * NS_PER_HOUR), now));
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        let snap = self.catalog_snapshot();
        // Visit files in descending arrival order (newest arrival first, docs/engine.md §4).
        let candidates = snap.candidates_by_ingest_desc(win.start_ns, win.end_ns, true);
        let deadline = Instant::now() + self.default_deadline;

        let mut collected: Vec<EventRow> = Vec::new();
        let mut collected_bytes = 0usize;
        let mut truncated = false;
        let mut files_searched = 0usize;

        for entry in &candidates {
            if collected.len() >= k || truncated {
                break;
            }
            files_searched += 1;
            let remaining_rows = k.saturating_sub(collected.len());
            let remaining_bytes = DEFAULT_MAX_BYTES.saturating_sub(collected_bytes);
            let sql_limit = remaining_rows + 1;
            let (file_rows, file_trunc) = self.query_single_file(entry, deadline, |conn| {
                if let Some(svc) = service {
                    let mut stmt = conn.prepare_cached(
                        "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                                trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                                body, json(attrs)
                         FROM events
                         WHERE service = ?1 AND ts BETWEEN ?2 AND ?3 AND instr(body, ?4) > 0
                         ORDER BY id DESC
                         LIMIT ?5",
                    )?;
                    let rows = stmt.query_map(
                        params![svc, win.start_ns, win.end_ns, needle, sql_limit as i64],
                        |r| map_event_row_with_day(r, &entry.day),
                    )?;
                    collect_rows_bounded(rows, &entry.day, remaining_rows, remaining_bytes)
                } else {
                    let mut stmt = conn.prepare_cached(
                        "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                                trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                                body, json(attrs)
                         FROM events
                         WHERE ts BETWEEN ?1 AND ?2 AND instr(body, ?3) > 0
                         ORDER BY id DESC
                         LIMIT ?4",
                    )?;
                    let rows = stmt.query_map(
                        params![win.start_ns, win.end_ns, needle, sql_limit as i64],
                        |r| map_event_row_with_day(r, &entry.day),
                    )?;
                    collect_rows_bounded(rows, &entry.day, remaining_rows, remaining_bytes)
                }
            })?;
            for r in file_rows {
                collected_bytes += r.estimated_bytes();
                collected.push(r);
            }
            if file_trunc {
                truncated = true;
                break;
            }
        }

        Ok(QueryResult {
            rows: collected,
            meta: self.build_meta(&snap, win, files_searched, truncated),
        })
    }

    /// Primitive 7: Attribute equality search via `attr(attrs, ?key) = ?val` (default 24 h),
    /// ordered by `ts DESC` using the merge rule (`docs/engine.md` §4).
    pub fn by_attr(
        &self,
        key: &str,
        val: &str,
        limit: usize,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<EventRow>, StoreError> {
        let now = self.clock.now_ns();
        let win = window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(24 * NS_PER_HOUR), now));
        let k = limit.clamp(1, DEFAULT_MAX_ROWS);
        let parsed_int = val.parse::<i64>().ok();
        self.run_descending_ts_merge(
            win,
            true,
            k,
            "SELECT id, ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact,
                    body, json(attrs)
             FROM events
             WHERE ts BETWEEN ?1 AND ?2
               AND (attr(attrs, ?3) = ?4 OR (?5 IS NOT NULL AND attr(attrs, ?3) = ?5))
             ORDER BY ts DESC, id DESC
             LIMIT ?6",
            |stmt, day, w0, w1, lim| {
                let rows =
                    stmt.query_map(params![w0, w1, key, val, parsed_int, lim as i64], map_event_row)?;
                collect_rows_bounded(rows, day, k, DEFAULT_MAX_BYTES)
            },
        )
    }

    /// Primitive 8: Sandboxed ad-hoc SQL over a `temp view events` that is a `UNION ALL` of
    /// attached files in the window (default 24 h, at most 30 days, plus `evidence.sqlite`)
    /// with the window inside each branch (`docs/engine.md` §4).
    pub fn sql(
        &self,
        select: &str,
        window: Option<TimeWindow>,
    ) -> Result<QueryResult<SqlRow>, StoreError> {
        let table = self.sql_table(select, window)?;
        let rows = table
            .rows
            .into_iter()
            .map(|values| SqlRow {
                columns: table.columns.iter().cloned().zip(values).collect(),
            })
            .collect();
        Ok(QueryResult {
            rows,
            meta: table.meta,
        })
    }

    /// Same sandbox as [`Reader::sql`], but keeps the statement's column order.
    pub fn sql_table(
        &self,
        select: &str,
        window: Option<TimeWindow>,
    ) -> Result<SqlTable, StoreError> {
        if has_multiple_statements(select) {
            return Err(StoreError::UnauthorizedSql(
                "multiple SQL statements are not allowed".to_owned(),
            ));
        }

        let now = self.clock.now_ns();
        let raw_win =
            window.unwrap_or_else(|| TimeWindow::new(now.saturating_sub(24 * NS_PER_HOUR), now));
        // Clamp window to at most 30 days (docs/engine.md §4).
        let max_span = 30 * NS_PER_DAY;
        let win = if raw_win.end_ns.saturating_sub(raw_win.start_ns) > max_span {
            TimeWindow::new(raw_win.end_ns - max_span, raw_win.end_ns)
        } else {
            raw_win
        };

        let snap = self.catalog_snapshot();
        let mut candidates = snap.candidates_by_max_ts_desc(win.start_ns, win.end_ns, true);
        // SQLITE_MAX_ATTACHED = 32 (§2.2). Mark result truncated if files beyond 32 are dropped.
        let attached_truncated = candidates.len() > 32;
        if attached_truncated {
            candidates.truncate(32);
        }

        let mut conn = Connection::open_in_memory()?;
        let cache_kib: i64 = 2048 + (candidates.len() as i64) * 256;
        conn.execute_batch(&format!(
            "PRAGMA cache_size = -{cache_kib};
             PRAGMA mmap_size = 0;
             PRAGMA temp_store = FILE;
             PRAGMA busy_timeout = 2000;"
        ))?;
        configure_reader_limits(&conn);
        crate::jsonb::register_attr_function(&conn)?;
        let _sql_guard = SqlInterruptGuard {
            pool: &self.pool,
            id: self.pool.register_sql_interrupt(conn.get_interrupt_handle()),
        };

        // Attach each file as d0, d1, ... and build TEMP VIEW events before enabling query_only.
        for (idx, entry) in candidates.iter().enumerate() {
            let uri = sqlite_file_uri(&entry.path, entry.state.is_sealed());
            let alias = format!("d{idx}");
            conn.execute(&format!("ATTACH DATABASE ?1 AS {alias}"), params![uri])?;
        }

        if candidates.is_empty() {
            let ddl = crate::schema::base_ddl(true, false);
            conn.execute_batch(&ddl)?;
        } else {
            let mut branches = Vec::with_capacity(candidates.len());
            let mut res_branches = Vec::with_capacity(candidates.len());
            let w0 = win.start_ns;
            let w1 = win.end_ns;
            for idx in 0..candidates.len() {
                branches.push(format!(
                    "SELECT * FROM d{idx}.events WHERE ts BETWEEN {w0} AND {w1}"
                ));
                res_branches.push(format!("SELECT * FROM d{idx}.resources"));
            }
            let view_sql = format!(
                "CREATE TEMP VIEW events AS {};
                 CREATE TEMP VIEW resources AS {};",
                branches.join(" UNION ALL "),
                res_branches.join(" UNION ALL ")
            );
            conn.execute_batch(&view_sql)?;
        }

        conn.execute_batch("PRAGMA query_only = 1;")?;

        // Install progress-handler deadline and authorizer before compiling user SQL (§4).
        let deadline = Instant::now() + self.default_deadline;
        conn.progress_handler(1000, Some(move || Instant::now() >= deadline))?;
        conn.authorizer(Some(sandbox_authorizer))?;

        let query_res = retry_busy_cli(self.read_only_cli_mode, || -> Result<_, StoreError> {
            let mut stmt = conn.prepare(select).map_err(map_sqlite_query_err)?;
            if !stmt.readonly() {
                return Err(StoreError::UnauthorizedSql(
                    "statement is not read-only".to_owned(),
                ));
            }
            let col_names: Vec<String> =
                stmt.column_names().map(str::to_owned).collect();
            let col_count = col_names.len();

            let mut rows_iter = stmt.query([]).map_err(map_sqlite_query_err)?;
            let mut out_rows: Vec<Vec<SqlValue>> = Vec::new();
            let mut total_bytes = 0usize;
            let mut truncated = false;

            while let Some(row) = rows_iter.next().map_err(map_sqlite_query_err)? {
                let mut values = Vec::with_capacity(col_count);
                let mut row_bytes = 0usize;
                for (i, name) in col_names.iter().enumerate().take(col_count) {
                    let val_ref = row.get_ref(i).map_err(map_sqlite_query_err)?;
                    let (sql_val, b_len) = value_ref_to_sql_value(val_ref);
                    row_bytes += name.len() + b_len + 8;
                    values.push(sql_val);
                }
                if out_rows.len() >= DEFAULT_MAX_ROWS
                    || total_bytes.saturating_add(row_bytes) > DEFAULT_MAX_BYTES
                {
                    truncated = true;
                    break;
                }
                total_bytes += row_bytes;
                out_rows.push(values);
            }
            Ok((col_names, out_rows, truncated))
        });

        let _ = conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let _ = conn.progress_handler(0, None::<fn() -> bool>);
        let _ = conn.release_memory();

        let (columns, rows, row_truncated) = query_res?;
        let truncated = row_truncated || attached_truncated;
        Ok(SqlTable {
            columns,
            rows,
            meta: self.build_meta(&snap, win, candidates.len(), truncated),
        })
    }

    /// Execute the descending-`max_ts` merge rule across overlapping files (`docs/engine.md` §4):
    /// visit files in descending `max_ts`; stop once `k` rows are collected and the next
    /// file's `max_ts` is older than the `k`-th row's `ts`.
    fn run_descending_ts_merge<F>(
        &self,
        win: TimeWindow,
        include_evidence: bool,
        k: usize,
        sql: &str,
        mut run_stmt: F,
    ) -> Result<QueryResult<EventRow>, StoreError>
    where
        F: FnMut(&mut rusqlite::Statement<'_>, &str, i64, i64, usize) -> rusqlite::Result<(Vec<EventRow>, bool)>,
    {
        let snap = self.catalog_snapshot();
        let candidates = snap.candidates_by_max_ts_desc(win.start_ns, win.end_ns, include_evidence);
        let deadline = Instant::now() + self.default_deadline;

        let mut collected: Vec<EventRow> = Vec::with_capacity(k);
        let mut files_searched = 0usize;
        let mut hit_more_than_k = false;

        for entry in &candidates {
            // Early-stop check: once K rows are collected and the next file's max_ts is strictly
            // older than the K-th row's ts, no remaining file can beat the K-th row (docs/engine.md §4).
            if collected.len() >= k {
                let kth_ts = collected[k - 1].ts;
                let next_max_ts = entry.max_ts.unwrap_or(i64::MIN);
                if next_max_ts < kth_ts {
                    break;
                }
            }

            files_searched += 1;
            let (file_rows, file_trunc) = self.query_single_file(entry, deadline, |conn| {
                let mut stmt = conn.prepare_cached(sql)?;
                run_stmt(&mut stmt, &entry.day, win.start_ns, win.end_ns, k + 1)
            })?;

            if file_trunc {
                hit_more_than_k = true;
            }

            collected.extend(file_rows);
            collected.sort_by(|a, b| {
                b.ts.cmp(&a.ts)
                    .then_with(|| b.day.cmp(&a.day))
                    .then_with(|| b.row_id.cmp(&a.row_id))
            });
            if collected.len() > k {
                hit_more_than_k = true;
                collected.truncate(k);
            }
        }

        let (rows, byte_truncated) = enforce_output_caps(collected, k, DEFAULT_MAX_BYTES);
        let truncated = hit_more_than_k || byte_truncated;

        Ok(QueryResult {
            rows,
            meta: self.build_meta(&snap, win, files_searched, truncated),
        })
    }

    fn query_single_file<T, F>(
        &self,
        entry: &CatalogEntry,
        deadline: Instant,
        mut f: F,
    ) -> Result<T, StoreError>
    where
        F: FnMut(&Connection) -> rusqlite::Result<T>,
    {
        let is_sealed = entry.state.is_sealed();
        retry_busy_cli(self.read_only_cli_mode, || {
            let mut conn = self.pool.checkout(&entry.path, is_sealed)?;
            conn.progress_handler(1000, Some(move || Instant::now() >= deadline))?;
            let res = f(&conn).map_err(map_sqlite_query_err);
            self.pool.checkin(entry.path.clone(), is_sealed, conn);
            res
        })
    }

    fn build_meta(
        &self,
        snap: &Catalog,
        window: TimeWindow,
        files_searched: usize,
        truncated: bool,
    ) -> QueryMeta {
        let max_ingest_ts = snap.max_ingest_ts();
        let staleness_ns = max_ingest_ts.map(|m| self.clock.now_ns().saturating_sub(m));
        QueryMeta {
            window,
            files_searched,
            truncated,
            max_ingest_ts,
            staleness_ns,
        }
    }
}

fn sandbox_authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name } => {
            if is_allowed_sql_function(function_name) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        _ => Authorization::Deny,
    }
}

fn is_allowed_sql_function(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "attr"
            | "count"
            | "sum"
            | "total"
            | "avg"
            | "min"
            | "max"
            | "group_concat"
            | "string_agg"
            | "substr"
            | "substring"
            | "instr"
            | "length"
            | "octet_length"
            | "lower"
            | "upper"
            | "trim"
            | "ltrim"
            | "rtrim"
            | "replace"
            | "hex"
            | "unhex"
            | "quote"
            | "printf"
            | "format"
            | "unicode"
            | "char"
            | "glob"
            | "like"
            | "abs"
            | "round"
            | "sign"
            | "coalesce"
            | "ifnull"
            | "nullif"
            | "iif"
            | "typeof"
            | "unlikely"
            | "likelihood"
            | "likely"
            | "json"
            | "json_extract"
            | "json_type"
            | "json_valid"
            | "json_array_length"
            | "datetime"
            | "date"
            | "time"
            | "strftime"
            | "julianday"
            | "unixepoch"
    )
}

fn has_multiple_statements(sql: &str) -> bool {
    let trimmed = sql.trim();
    let without_trailing = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let mut in_single = false;
    let mut in_double = false;
    let bytes = without_trailing.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if !in_double => {
                if in_single && i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = !in_single;
            }
            b'"' if !in_single => {
                in_double = !in_double;
            }
            b';' if !in_single && !in_double => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

fn map_sqlite_query_err(err: rusqlite::Error) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(ffi_err, msg) => match ffi_err.code {
            rusqlite::ErrorCode::OperationInterrupted => StoreError::QueryDeadlineExceeded,
            rusqlite::ErrorCode::AuthorizationForStatementDenied
            | rusqlite::ErrorCode::ReadOnly => StoreError::UnauthorizedSql(
                msg.clone()
                    .unwrap_or_else(|| "authorization denied".to_owned()),
            ),
            _ => {
                if let Some(m) = msg {
                    if m.contains("not authorized") || m.contains("cannot modify") {
                        return StoreError::UnauthorizedSql(m.clone());
                    }
                }
                StoreError::Sqlite(err)
            }
        },
        rusqlite::Error::SqlInputError { error, msg, .. } => match error.code {
            rusqlite::ErrorCode::AuthorizationForStatementDenied
            | rusqlite::ErrorCode::ReadOnly => StoreError::UnauthorizedSql(msg.clone()),
            _ if msg.contains("not authorized") || msg.contains("cannot modify") => {
                StoreError::UnauthorizedSql(msg.clone())
            }
            _ => StoreError::Sqlite(err),
        },
        _ => StoreError::Sqlite(err),
    }
}

fn retry_busy_cli<T, F: FnMut() -> Result<T, StoreError>>(
    is_cli_mode: bool,
    mut f: F,
) -> Result<T, StoreError> {
    let max_retries = if is_cli_mode { 3 } else { 1 };
    let mut retries = 0;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(StoreError::Sqlite(rusqlite::Error::SqliteFailure(err, ref msg)))
                if (err.code == rusqlite::ErrorCode::DatabaseBusy
                    || err.code == rusqlite::ErrorCode::DatabaseLocked)
                    && retries < max_retries =>
            {
                let _ = msg;
                retries += 1;
                thread::sleep(Duration::from_millis(15 * retries));
            }
            Err(e) => return Err(e),
        }
    }
}

fn map_event_row(row: &Row<'_>) -> rusqlite::Result<EventRow> {
    map_event_row_with_day(row, "")
}

fn map_event_row_with_day(row: &Row<'_>, day: &str) -> rusqlite::Result<EventRow> {
    let row_id: i64 = row.get(0)?;
    let ts: i64 = row.get(1)?;
    let ingest_ts: i64 = row.get(2)?;
    let dur: Option<i64> = row.get(3)?;
    let kind_str: String = row.get(4)?;
    let service: String = row.get(5)?;
    let severity: Option<i32> = row.get(6)?;
    let status: Option<String> = row.get(7)?;
    let err_int: i64 = row.get(8)?;
    let name: Option<String> = row.get(9)?;
    let trace_blob: Option<Vec<u8>> = row.get(10)?;
    let span_blob: Option<Vec<u8>> = row.get(11)?;
    let parent_blob: Option<Vec<u8>> = row.get(12)?;
    let session_id: Option<String> = row.get(13)?;
    let request_id: Option<String> = row.get(14)?;
    let res: Option<i64> = row.get(15)?;
    let src_int: Option<i64> = row.get(16)?;
    let artifact: Option<String> = row.get(17)?;
    let body: Option<String> = row.get(18)?;
    let attrs: Option<String> = row.get(19)?;

    let trace_id = trace_blob.and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok());
    let span_id = span_blob.and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok());
    let parent_id = parent_blob.and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok());

    Ok(EventRow {
        id: if day.is_empty() {
            row_id.to_string()
        } else {
            format!("{day}:{row_id}")
        },
        day: day.to_owned(),
        row_id,
        ts,
        ingest_ts,
        dur,
        kind: EventKind::from_str(&kind_str),
        service,
        severity,
        status,
        err: err_int != 0,
        name,
        trace_id,
        span_id,
        parent_id,
        session_id,
        request_id,
        res,
        src: EventSource::from_i64(src_int.unwrap_or(0)),
        artifact,
        body,
        attrs,
    })
}

/// Collect mapped event rows until `max_rows` or `max_bytes` (by [`EventRow::estimated_bytes`])
/// would be exceeded; the flag is true when rows were left behind. Rows without a day get
/// `day` and an id of `<day>:<rowid>`.
pub fn collect_rows_bounded<I>(
    iter: I,
    day: &str,
    max_rows: usize,
    max_bytes: usize,
) -> rusqlite::Result<(Vec<EventRow>, bool)>
where
    I: Iterator<Item = rusqlite::Result<EventRow>>,
{
    let mut out = Vec::with_capacity(max_rows.min(128));
    let mut total_bytes = 0usize;
    let mut truncated = false;

    for item in iter {
        let mut r = item?;
        if !day.is_empty() && r.day.is_empty() {
            r.day = day.to_owned();
            r.id = format!("{day}:{}", r.row_id);
        }
        let row_bytes = r.estimated_bytes();
        if out.len() >= max_rows || total_bytes.saturating_add(row_bytes) > max_bytes {
            truncated = true;
            break;
        }
        total_bytes += row_bytes;
        out.push(r);
    }

    Ok((out, truncated))
}

fn enforce_output_caps(
    rows: Vec<EventRow>,
    max_rows: usize,
    max_bytes: usize,
) -> (Vec<EventRow>, bool) {
    let mut out = Vec::with_capacity(rows.len().min(max_rows));
    let mut total_bytes = 0usize;
    let mut truncated = false;

    for r in rows {
        let row_bytes = r.estimated_bytes();
        if out.len() >= max_rows || total_bytes.saturating_add(row_bytes) > max_bytes {
            truncated = true;
            break;
        }
        total_bytes += row_bytes;
        out.push(r);
    }

    (out, truncated)
}

fn value_ref_to_sql_value(v: ValueRef<'_>) -> (SqlValue, usize) {
    match v {
        ValueRef::Null => (SqlValue::Null, 4),
        ValueRef::Integer(i) => (SqlValue::Integer(i), 8),
        ValueRef::Real(f) => (SqlValue::Real(f), 8),
        ValueRef::Text(b) => {
            let s = String::from_utf8_lossy(b).into_owned();
            let len = s.len();
            (SqlValue::Text(s), len)
        }
        ValueRef::Blob(b) => {
            let vec = b.to_vec();
            let len = vec.len();
            (SqlValue::Blob(vec), len)
        }
    }
}
