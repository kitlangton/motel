use std::path::Path;
use std::sync::Once;

use rusqlite::limits::Limit;
use rusqlite::{params, Connection, OptionalExtension};

use crate::jsonb::register_attr_function;
use crate::StoreError;

/// SQLite >= 3.51.3 version floor required to avoid the WAL-reset corruption
/// race between a checkpointer and a writer on separate connections (engine.md §2.2).
pub const MIN_SQLITE_VERSION_NUMBER: i32 = 3_051_003;

/// Soft SQLite heap limit: 18 MiB (engine.md §2.2).
pub const SOFT_HEAP_LIMIT_BYTES: i64 = 18 * 1024 * 1024;

/// Hard SQLite heap limit: 28 MiB (engine.md §2.2).
pub const HARD_HEAP_LIMIT_BYTES: i64 = 28 * 1024 * 1024;

/// Maximum body size in bytes (16 KiB, engine.md §2.1).
pub const MAX_BODY_BYTES: usize = 16 * 1024;

static HEAP_LIMITS_INIT: Once = Once::new();

/// Check an arbitrary SQLite version number against the 3.51.3 floor.
pub fn check_sqlite_version_number(version_number: i32) -> Result<(), StoreError> {
    if version_number < MIN_SQLITE_VERSION_NUMBER {
        return Err(StoreError::SqliteVersionTooOld {
            found: version_number,
            minimum: MIN_SQLITE_VERSION_NUMBER,
        });
    }
    Ok(())
}

/// Verify the bundled SQLite version floor and initialize process-wide heap limits.
pub fn ensure_sqlite_environment() -> Result<(), StoreError> {
    check_sqlite_version_number(rusqlite::version_number())?;
    HEAP_LIMITS_INIT.call_once(|| unsafe {
        // Set hard limit first because sqlite3_hard_heap_limit64 clamps soft_heap_limit if unset.
        rusqlite::ffi::sqlite3_hard_heap_limit64(HARD_HEAP_LIMIT_BYTES);
        rusqlite::ffi::sqlite3_soft_heap_limit64(SOFT_HEAP_LIMIT_BYTES);
    });
    Ok(())
}

/// Temporarily adjust the SQLite hard heap limit (used in tests for SQLITE_NOMEM recovery).
pub fn set_sqlite_heap_limits(soft_bytes: i64, hard_bytes: i64) {
    unsafe {
        rusqlite::ffi::sqlite3_hard_heap_limit64(hard_bytes);
        rusqlite::ffi::sqlite3_soft_heap_limit64(soft_bytes);
    }
}

/// Build the DDL for a day file or `evidence.sqlite` (engine.md §2.1).
pub fn base_ddl(with_ix_req: bool, payloads_split: bool) -> String {
    let mut ddl = String::from(
        r#"
create table if not exists resources (
  id integer primary key,
  hash blob not null unique,
  host text,
  service text,
  version text,
  pid integer,
  attrs blob
);

create table if not exists events (
  id          integer primary key,
  ts          integer not null,
  ingest_ts   integer not null,
  dur         integer,
  kind        text not null,
  service     text not null,
  severity    integer,
  status      text,
  err         integer not null default 0,
  name        text,
  trace_id    blob,
  span_id     blob,
  parent_id   blob,
  session_id  text,
  request_id  text,
  res         integer references resources(id),
  src         integer,
  artifact    text,
  body        text,
  attrs       blob
);

create index if not exists ix_ts      on events(ts);
create index if not exists ix_svc_ts  on events(service, ts);
create index if not exists ix_err     on events(service, ts) where err = 1;
create index if not exists ix_trace   on events(trace_id, ts) where trace_id is not null;
create index if not exists ix_session on events(session_id, ts) where session_id is not null;
"#,
    );

    if with_ix_req {
        ddl.push_str(
            "create index if not exists ix_req     on events(request_id, ts) where request_id is not null;\n",
        );
    }

    ddl.push_str(
        r#"
create table if not exists cursors (
  source text primary key,
  dev integer,
  ino integer,
  head_hash blob,
  offset integer not null,
  updated_ingest_ts integer not null
) without rowid;

create table if not exists _meta (
  k text primary key,
  v
) without rowid;

-- Optional block bloom table (engine.md §2.1, §8 B2).
-- TODO(engine.md §2.1, §8 B2): populate block_bloom only if B2 shows absent substring needs it.
create table if not exists block_bloom (
  block integer primary key,
  first_id integer not null,
  last_id integer not null,
  k integer not null,
  bits blob not null
);
"#,
    );

    if payloads_split {
        ddl.push_str(
            r#"
create table if not exists payloads (
  id integer primary key,
  body text,
  attrs blob
);
"#,
        );
    }

    ddl
}

/// Extra tables added in `evidence.sqlite` (engine.md §2.1, §2.7).
pub const EVIDENCE_EXTRA_DDL: &str = r#"
create table if not exists purges (
  id integer primary key,
  created_ts integer,
  predicate text,
  since_ts integer,
  until_ts integer,
  state text,
  done text
);

create table if not exists artifacts (
  id integer primary key,
  day text not null,
  path text not null,
  bytes integer not null,
  sha256 blob,
  created_ts integer not null
);
"#;

/// Configure PRAGMAs on a hot writer connection (engine.md §2.2).
pub fn configure_hot_writer_conn(
    conn: &Connection,
    page_size: u32,
    sync_full: bool,
) -> Result<(), StoreError> {
    let sync_mode = if sync_full { "FULL" } else { "NORMAL" };
    let sql = format!(
        "PRAGMA page_size = {page_size};
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = {sync_mode};
         PRAGMA fullfsync = ON;
         PRAGMA checkpoint_fullfsync = ON;
         PRAGMA wal_autocheckpoint = 0;
         PRAGMA journal_size_limit = 16777216;
         PRAGMA cache_size = -8192;
         PRAGMA mmap_size = 0;
         PRAGMA temp_store = FILE;
         PRAGMA secure_delete = FAST;
         PRAGMA busy_timeout = 5000;"
    );
    conn.execute_batch(&sql)?;
    register_attr_function(conn)?;
    Ok(())
}

/// Configure PRAGMAs on `evidence.sqlite` writer connection (engine.md §2.7).
pub fn configure_evidence_writer_conn(
    conn: &Connection,
    page_size: u32,
) -> Result<(), StoreError> {
    // evidence.sqlite always runs in WAL mode with synchronous=FULL (writes are rare, §2.7).
    configure_hot_writer_conn(conn, page_size, true)
}

/// Configure PRAGMAs on the checkpointer connection (engine.md §2.2).
pub fn configure_checkpointer_conn(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA fullfsync = ON;
         PRAGMA checkpoint_fullfsync = ON;
         PRAGMA journal_size_limit = 16777216;
         PRAGMA cache_size = -512;
         PRAGMA mmap_size = 0;
         PRAGMA busy_timeout = 2000;",
    )?;
    Ok(())
}

/// Build a percent-encoded SQLite `file:` URI for read-only access (`docs/engine.md` §2.2, §4).
pub fn sqlite_file_uri(path: &Path, immutable: bool) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::with_capacity(raw.len() + 32);
    encoded.push_str("file:");
    for b in raw.bytes() {
        match b {
            b'%' => encoded.push_str("%25"),
            b'?' => encoded.push_str("%3F"),
            b'#' => encoded.push_str("%23"),
            b' ' => encoded.push_str("%20"),
            0x00..=0x1f | 0x7f => {
                encoded.push_str(&format!("%{b:02X}"));
            }
            _ => encoded.push(b as char),
        }
    }
    if immutable {
        encoded.push_str("?mode=ro&immutable=1");
    } else {
        encoded.push_str("?mode=ro");
    }
    encoded
}

/// Apply defensive per-connection SQLite limits to a reader or sandboxed SQL connection (`docs/engine.md` §4).
pub fn configure_reader_limits(conn: &Connection) {
    // Cap any single string/blob allocation (e.g. printf, group_concat, zeroblob) at 1 MiB.
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, 1_048_576);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 65_536);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 128);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 64);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 64);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 25_000);
    let _ = conn.set_limit(Limit::SQLITE_LIMIT_FUNCTION_ARG, 16);
}

/// Configure PRAGMAs on a reader connection (`docs/engine.md` §2.2).
/// `attached_count` adds 256 KiB per attached file above the 2 MiB base cache.
pub fn configure_reader_conn(
    conn: &Connection,
    attached_count: usize,
) -> Result<(), StoreError> {
    let cache_kib: i64 = 2048 + (attached_count as i64) * 256;
    let sql = format!(
        "PRAGMA cache_size = -{cache_kib};
         PRAGMA mmap_size = 0;
         PRAGMA temp_store = FILE;
         PRAGMA query_only = 1;
         PRAGMA busy_timeout = 2000;"
    );
    conn.execute_batch(&sql)?;
    configure_reader_limits(conn);
    register_attr_function(conn)?;
    Ok(())
}

/// Initialize `_meta` defaults if they are not yet set in a freshly created day or evidence file.
pub fn init_meta_defaults(
    conn: &Connection,
    day: &str,
    machine: &str,
    state: &str,
) -> Result<(), StoreError> {
    let sqlite_ver = rusqlite::version();
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('format_version', 1)",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('machine', ?1)",
        params![machine],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('day', ?1)",
        params![day],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('state', ?1)",
        params![state],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('rows', 0)",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO _meta (k, v) VALUES ('sqlite_version', ?1)",
        params![sqlite_ver],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct FileMetaSummary {
    pub day: Option<String>,
    pub state: Option<String>,
    pub min_ts: Option<i64>,
    pub max_ts: Option<i64>,
    pub min_ingest_ts: Option<i64>,
    pub max_ingest_ts: Option<i64>,
    pub durable_ingest_ts: Option<i64>,
    pub rows: i64,
}

/// Read the summary metadata from `_meta` in `conn`.
pub fn read_file_meta(conn: &Connection) -> Result<FileMetaSummary, StoreError> {
    let mut summary = FileMetaSummary::default();
    let has_meta: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_meta'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if has_meta.is_none() {
        return Ok(summary);
    }

    let mut stmt = conn.prepare("SELECT k, CAST(v AS TEXT) FROM _meta")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let k: String = row.get(0)?;
        let v: Option<String> = row.get(1)?;
        let Some(v) = v else { continue };
        match k.as_str() {
            "day" => summary.day = Some(v),
            "state" => summary.state = Some(v),
            "min_ts" => summary.min_ts = v.parse::<i64>().ok(),
            "max_ts" => summary.max_ts = v.parse::<i64>().ok(),
            "min_ingest_ts" => summary.min_ingest_ts = v.parse::<i64>().ok(),
            "max_ingest_ts" => summary.max_ingest_ts = v.parse::<i64>().ok(),
            "durable_ingest_ts" => summary.durable_ingest_ts = v.parse::<i64>().ok(),
            "rows" => summary.rows = v.parse::<i64>().unwrap_or(0),
            _ => {}
        }
    }
    Ok(summary)
}
