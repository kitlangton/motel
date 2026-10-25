pub mod catalog;
pub mod jsonb;
pub mod reader;
pub mod schema;
pub mod seal;
pub mod writer;

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub use crate::catalog::{
    parse_utc_day_start_ns, unlink_sealed_days_before, utc_day_string, Catalog, CatalogEntry,
    DayFileState, NS_PER_DAY, NS_PER_HOUR, NS_PER_MINUTE, NS_PER_SECOND,
};
pub use crate::reader::{
    Reader, ReaderPool, DEFAULT_MAX_BYTES, DEFAULT_MAX_ROWS, DEFAULT_QUERY_DEADLINE,
    MAX_QUERY_DEADLINE,
};
pub use crate::schema::{
    check_sqlite_version_number, ensure_sqlite_environment, set_sqlite_heap_limits,
    HARD_HEAP_LIMIT_BYTES, MAX_BODY_BYTES, MIN_SQLITE_VERSION_NUMBER, SOFT_HEAP_LIMIT_BYTES,
};
pub use crate::seal::seal_day_file;
pub use crate::writer::{
    current_process_cpu_ns, current_thread_cpu_ns, expire_evidence_rows, query_latest_cursor, Ack,
    ManualClock, Writer, WriterMetrics,
};

use crate::seal::{recover_on_startup, LockFile};
use crate::writer::WriterControl;

/// Injectable clock trait for arrival-day routing, sealing, and staleness (engine.md §2.4, §2.5).
pub trait Clock: Send + Sync + 'static {
    fn now_ns(&self) -> i64;
}

/// Real system wall clock (`SystemTime::now()`).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ns(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0)
    }
}

/// Durability mode for the hot day writer (engine.md §3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum DurabilityMode {
    /// Default (`synchronous=NORMAL` per commit, `synchronous=FULL` durability tick every 1 s).
    #[default]
    ModeT,
    /// Full sync (`synchronous=FULL` with `F_FULLFSYNC` on every commit).
    ModeF,
}

/// Event kind (`events.kind`, engine.md §2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    Span,
    Log,
    Metric,
    Crash,
    Profile,
    Inspect,
    Run,
    Test,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Span => "span",
            EventKind::Log => "log",
            EventKind::Metric => "metric",
            EventKind::Crash => "crash",
            EventKind::Profile => "profile",
            EventKind::Inspect => "inspect",
            EventKind::Run => "run",
            EventKind::Test => "test",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "span" => EventKind::Span,
            "log" => EventKind::Log,
            "metric" => EventKind::Metric,
            "crash" => EventKind::Crash,
            "profile" => EventKind::Profile,
            "inspect" => EventKind::Inspect,
            "run" => EventKind::Run,
            "test" => EventKind::Test,
            _ => EventKind::Log,
        }
    }
}

/// Event source (`events.src`, engine.md §2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[repr(i64)]
pub enum EventSource {
    #[default]
    Otlp = 0,
    File = 1,
    Ips = 2,
    Unified = 3,
    Run = 4,
    Evidence = 5,
}

impl EventSource {
    pub fn from_i64(v: i64) -> Self {
        match v {
            0 => EventSource::Otlp,
            1 => EventSource::File,
            2 => EventSource::Ips,
            3 => EventSource::Unified,
            4 => EventSource::Run,
            5 => EventSource::Evidence,
            _ => EventSource::Otlp,
        }
    }
}

/// Resource metadata interned once per file behind a 4,096-entry LRU (engine.md §2.1, §2.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resource {
    pub host: Option<String>,
    pub service: String,
    pub version: Option<String>,
    pub pid: Option<i64>,
    /// Canonical JSON string of resource attributes (stored via `jsonb(?)`).
    pub attrs: Option<String>,
}

/// Normalized input event row submitted to [`Writer::submit`] (engine.md §2.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// Event timestamp in Unix nanoseconds.
    pub ts: i64,
    /// Optional explicit arrival timestamp in Unix nanoseconds (defaults to writer clock `now_ns`).
    pub ingest_ts: Option<i64>,
    /// Duration in nanoseconds.
    pub dur: Option<i64>,
    pub kind: EventKind,
    pub service: String,
    /// OTLP severity number (1..=24; >= 17 is ERROR).
    pub severity: Option<i32>,
    /// `ok` | `error` | `pass` | `fail` | `None`.
    pub status: Option<String>,
    /// Explicit error flag; also automatically true when `severity >= 17`, `status` is `error`/`fail`,
    /// or `kind` is `Crash`.
    pub err: bool,
    pub name: Option<String>,
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub parent_id: Option<[u8; 8]>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub resource: Option<Resource>,
    pub src: EventSource,
    pub artifact: Option<String>,
    /// UTF-8 body, automatically capped at 16 KiB on insert.
    pub body: Option<String>,
    /// Canonical JSON object string of attributes (inserted via `jsonb(?)`).
    pub attrs: Option<String>,
}

impl Event {
    /// Compute the `err` column value (engine.md §2.1: span error, severity>=17, crash, failed run/test).
    pub fn compute_err(&self) -> bool {
        self.err
            || self.kind == EventKind::Crash
            || self.severity.is_some_and(|s| s >= 17)
            || self
                .status
                .as_deref()
                .is_some_and(|st| st.eq_ignore_ascii_case("error") || st.eq_ignore_ascii_case("fail"))
    }

    /// Returns true if this event routes to `evidence.sqlite` rather than the hot day file
    /// (engine.md §2.7: crash, profile, inspect, run, and failed-test rows).
    pub fn is_evidence(&self) -> bool {
        match self.kind {
            EventKind::Crash | EventKind::Profile | EventKind::Inspect | EventKind::Run => true,
            EventKind::Test => self.compute_err(),
            EventKind::Span | EventKind::Log | EventKind::Metric => false,
        }
    }

    /// Estimate the in-memory byte footprint of this normalized row for queue admission (§3.1).
    pub fn estimated_bytes(&self) -> usize {
        128 + self.service.len()
            + self.status.as_ref().map_or(0, String::len)
            + self.name.as_ref().map_or(0, String::len)
            + self.session_id.as_ref().map_or(0, String::len)
            + self.request_id.as_ref().map_or(0, String::len)
            + self.artifact.as_ref().map_or(0, String::len)
            + self.body.as_ref().map_or(0, |b| b.len().min(MAX_BODY_BYTES))
            + self.attrs.as_ref().map_or(0, String::len)
            + self.resource.as_ref().map_or(0, |r| {
                32 + r.service.len()
                    + r.host.as_ref().map_or(0, String::len)
                    + r.version.as_ref().map_or(0, String::len)
                    + r.attrs.as_ref().map_or(0, String::len)
            })
    }
}

/// Tailer cursor update committed in the same transaction as its rows (engine.md §2.1, §3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorUpdate {
    pub source: String,
    pub dev: Option<i64>,
    pub ino: Option<i64>,
    pub head_hash: Option<Vec<u8>>,
    pub offset: i64,
    pub updated_ingest_ts: i64,
    pub is_evidence: bool,
}

/// Acknowledgement returned once a submitted batch is committed (engine.md §3.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitAck {
    pub day: String,
    pub rows_committed: usize,
    pub ingest_ts: i64,
}

/// Typed admission/submission error; [`SubmitError::QueueFull`] maps to HTTP 429 + `Retry-After: 1` (§3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitError {
    QueueFull { retry_after_secs: u32 },
    Closed,
}

impl fmt::Display for SubmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SubmitError::QueueFull { retry_after_secs } => write!(
                f,
                "writer queue full (429 Too Many Requests, Retry-After: {retry_after_secs})"
            ),
            SubmitError::Closed => write!(f, "writer channel is closed"),
        }
    }
}

impl std::error::Error for SubmitError {}

/// Stored event row returned by [`Reader`] query primitives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRow {
    /// Composite API identifier `"<D>:<id>"` (engine.md §2.1).
    pub id: String,
    pub day: String,
    pub row_id: i64,
    pub ts: i64,
    pub ingest_ts: i64,
    pub dur: Option<i64>,
    pub kind: EventKind,
    pub service: String,
    pub severity: Option<i32>,
    pub status: Option<String>,
    pub err: bool,
    pub name: Option<String>,
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub parent_id: Option<[u8; 8]>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub res: Option<i64>,
    pub src: EventSource,
    pub artifact: Option<String>,
    pub body: Option<String>,
    pub attrs: Option<String>,
}

impl EventRow {
    pub fn estimated_bytes(&self) -> usize {
        128 + self.id.len()
            + self.day.len()
            + self.service.len()
            + self.status.as_ref().map_or(0, String::len)
            + self.name.as_ref().map_or(0, String::len)
            + self.session_id.as_ref().map_or(0, String::len)
            + self.request_id.as_ref().map_or(0, String::len)
            + self.artifact.as_ref().map_or(0, String::len)
            + self.body.as_ref().map_or(0, String::len)
            + self.attrs.as_ref().map_or(0, String::len)
    }
}

/// Dynamic SQL value returned by [`Reader::sql`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Row returned by [`Reader::sql`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqlRow {
    pub columns: BTreeMap<String, SqlValue>,
}

/// Inclusive event-time query window `[start_ns, end_ns]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeWindow {
    pub start_ns: i64,
    pub end_ns: i64,
}

impl TimeWindow {
    pub fn new(start_ns: i64, end_ns: i64) -> Self {
        Self { start_ns, end_ns }
    }
}

/// Metadata returned with every [`Reader`] query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryMeta {
    pub window: TimeWindow,
    pub files_searched: usize,
    pub truncated: bool,
    pub max_ingest_ts: Option<i64>,
    pub staleness_ns: Option<i64>,
}

/// Query result combining typed rows and [`QueryMeta`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryResult<T> {
    pub rows: Vec<T>,
    pub meta: QueryMeta,
}

/// Configuration for [`Store::open`].
#[derive(Debug, Clone)]
pub struct StoreConfig {
    pub root_dir: PathBuf,
    pub machine: String,
    pub durability_mode: DurabilityMode,
    /// SQLite page size: 4096 default; 8192 is a B1 variant (engine.md §2.2, §8).
    pub page_size: u32,
    /// Include `ix_req` index on `events(request_id, ts)` (default true; B1 tests with/without).
    pub with_ix_req: bool,
    /// Split `body` and `attrs` into a separate `payloads` table (default false = wide `events`, §8 B1).
    pub payloads_split: bool,
    /// Encode JSONB directly in Rust rather than SQLite `jsonb(?)` (default false = `jsonb(?)`, §2.3).
    pub direct_jsonb: bool,
    /// Queue byte budget before returning 429 (default 4 MiB, engine.md §3.1).
    pub queue_byte_budget: usize,
    /// Group commit time window (default 50 ms, engine.md §3.2).
    pub group_commit_interval: Duration,
    /// Group commit row threshold (default 2,048 rows, engine.md §3.2).
    pub group_commit_max_rows: usize,
    /// Group commit byte threshold (default 1 MiB, engine.md §3.2).
    pub group_commit_max_bytes: usize,
    /// Default reader progress-handler deadline (default 2 s, max 10 s, engine.md §4).
    pub query_deadline: Duration,
    /// Optional test hook: stop background sealing after step N (1..=5) to simulate crashes (§2.5).
    pub seal_stop_after_step: Option<u8>,
}

impl StoreConfig {
    pub fn new(root_dir: impl AsRef<Path>) -> Self {
        Self {
            root_dir: root_dir.as_ref().to_path_buf(),
            machine: "local".to_owned(),
            durability_mode: DurabilityMode::ModeT,
            page_size: 4096,
            with_ix_req: true,
            payloads_split: false,
            direct_jsonb: false,
            queue_byte_budget: 4 * 1024 * 1024,
            group_commit_interval: Duration::from_millis(50),
            group_commit_max_rows: 2_048,
            group_commit_max_bytes: 1_048_576,
            query_deadline: DEFAULT_QUERY_DEADLINE,
            seal_stop_after_step: None,
        }
    }
}

/// Errors returned by `motel-store`.
#[derive(Debug)]
pub enum StoreError {
    SqliteVersionTooOld { found: i32, minimum: i32 },
    AlreadyLocked(PathBuf),
    CorruptDayFile { day: String, details: String },
    QueryDeadlineExceeded,
    UnauthorizedSql(String),
    Closed,
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Other(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::SqliteVersionTooOld { found, minimum } => write!(
                f,
                "SQLite version {found} is below required minimum {minimum} (3.51.3)"
            ),
            StoreError::AlreadyLocked(p) => {
                write!(f, "store lock is already held by another process: {}", p.display())
            }
            StoreError::CorruptDayFile { day, details } => {
                write!(f, "day file {day} failed quick_check and was quarantined: {details}")
            }
            StoreError::QueryDeadlineExceeded => write!(f, "query exceeded progress deadline"),
            StoreError::UnauthorizedSql(msg) => write!(f, "unauthorized SQL: {msg}"),
            StoreError::Closed => write!(f, "store is closed"),
            StoreError::Sqlite(e) => write!(f, "sqlite error: {e}"),
            StoreError::Io(e) => write!(f, "io error: {e}"),
            StoreError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

/// Top-level day-split SQLite storage engine instance (engine.md §1–§5).
pub struct Store {
    config: StoreConfig,
    _lock: LockFile,
    catalog: Arc<RwLock<Catalog>>,
    reader_pool: Arc<ReaderPool>,
    writer_ctl: WriterControl,
    reader: Reader,
    quarantined_days: Vec<String>,
}

impl Store {
    /// Open the store using the system wall clock, running startup recovery (§3.4) and spawning
    /// the writer and checkpointer threads.
    pub fn open(config: StoreConfig) -> Result<Self, StoreError> {
        Self::open_with_clock(config, Arc::new(SystemClock))
    }

    /// Open the store with an injectable [`Clock`] (used by tests to roll UTC days).
    pub fn open_with_clock(
        config: StoreConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, StoreError> {
        ensure_sqlite_environment()?;
        let lock = LockFile::acquire(&config.root_dir)?;
        let catalog = Arc::new(RwLock::new(Catalog::default()));
        let now_ns = clock.now_ns();
        let today = utc_day_string(now_ns);

        let mut quarantined_days = Vec::new();
        recover_on_startup(
            &config.root_dir,
            &today,
            now_ns,
            &catalog,
            &mut quarantined_days,
        )?;

        let scanned = Catalog::scan_dir(&config.root_dir)?;
        *catalog.write().unwrap() = scanned;

        let reader_pool = Arc::new(ReaderPool::new());
        let writer_ctl = WriterControl::spawn(
            config.clone(),
            Arc::clone(&clock),
            Arc::clone(&catalog),
            Arc::clone(&reader_pool),
        )?;

        let reader = Reader::new(
            config.root_dir.clone(),
            Arc::clone(&catalog),
            Arc::clone(&reader_pool),
            clock,
            config.query_deadline,
            false,
        );

        Ok(Self {
            config,
            _lock: lock,
            catalog,
            reader_pool,
            writer_ctl,
            reader,
            quarantined_days,
        })
    }

    /// Return a cloneable [`Writer`] handle.
    pub fn writer(&self) -> Writer {
        self.writer_ctl.handle()
    }

    /// Return a cloneable [`Reader`] handle.
    pub fn reader(&self) -> Reader {
        self.reader.clone()
    }

    /// Return a snapshot of the current file catalog.
    pub fn catalog_snapshot(&self) -> Catalog {
        self.catalog.read().unwrap().clone()
    }

    /// Return the list of day files quarantined as `<D>.corrupt.sqlite` during startup recovery.
    pub fn quarantined_days(&self) -> &[String] {
        &self.quarantined_days
    }

    /// Return the cursor with the newest `updated_ingest_ts` across today's, yesterday's,
    /// and `evidence.sqlite` files (engine.md §3.4).
    pub fn latest_cursor(&self, source: &str) -> Result<Option<CursorUpdate>, StoreError> {
        query_latest_cursor(&self.catalog, source)
    }

    /// Simple retention unlink of sealed day files older than `cutoff_day` (`YYYY-MM-DD`).
    pub fn unlink_expired_days(&self, cutoff_day: &str) -> Result<Vec<PathBuf>, StoreError> {
        self.reader_pool.close_all();
        unlink_sealed_days_before(&self.config.root_dir, &self.catalog, cutoff_day)
    }
}
