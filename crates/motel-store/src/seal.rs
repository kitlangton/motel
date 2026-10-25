use std::fs::{self, File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::catalog::{inspect_file, parse_day_filename, Catalog, DayFileState};
use crate::reader::ReaderPool;
use crate::StoreError;

/// Exclusive flock on `<root>/motel.lock` held by the active daemon/Store instance (engine.md §2, §3.4).
pub struct LockFile {
    _file: File,
    path: PathBuf,
}

impl LockFile {
    pub fn acquire(root: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(root)?;
        let path = root.join("motel.lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::WouldBlock
                || err.raw_os_error() == Some(libc::EWOULDBLOCK)
                || err.raw_os_error() == Some(libc::EAGAIN)
            {
                return Err(StoreError::AlreadyLocked(path));
            }
            return Err(StoreError::Io(err));
        }
        Ok(Self { _file: file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Set background QoS on the current sealer thread on macOS (engine.md §2.5).
pub fn set_background_qos() {
    #[cfg(target_os = "macos")]
    unsafe {
        // QOS_CLASS_BACKGROUND = 0x09
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
    }
}

/// Issue `F_FULLFSYNC` on `path` on macOS (fallback to `sync_all` elsewhere).
pub fn full_fsync_file(path: &Path) -> Result<(), StoreError> {
    let f = OpenOptions::new().read(true).write(true).open(path)?;
    #[cfg(target_os = "macos")]
    {
        let rc = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) };
        if rc != 0 {
            f.sync_all()?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        f.sync_all()?;
    }
    Ok(())
}

/// Issue `fsync` on a directory path.
pub fn fsync_dir(dir: &Path) -> Result<(), StoreError> {
    let f = File::open(dir)?;
    f.sync_all()?;
    Ok(())
}

fn retry_on_busy<T, F: FnMut() -> rusqlite::Result<T>>(mut f: F) -> Result<T, StoreError> {
    let mut attempts = 0;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(rusqlite::Error::SqliteFailure(err, ref msg))
                if (err.code == rusqlite::ErrorCode::DatabaseBusy
                    || err.code == rusqlite::ErrorCode::DatabaseLocked)
                    && attempts < 10 =>
            {
                let _ = msg;
                attempts += 1;
                thread::sleep(Duration::from_millis(20 * attempts));
            }
            Err(e) => return Err(StoreError::Sqlite(e)),
        }
    }
}

/// Seal `<root>/days/<day>.hot.sqlite` in place into `<root>/days/<day>.sqlite` (engine.md §2.5).
///
/// Steps (all idempotent):
/// 1. Mark `day` as sealing, close daemon readers, set `_meta.state = 'sealing'`.
/// 2. `PRAGMA wal_checkpoint(TRUNCATE)`.
/// 3. `PRAGMA quick_check` (quarantine as `<day>.corrupt.sqlite` on failure).
/// 4. `ANALYZE`, set `_meta.state = 'sealed'` and `_meta.sealed_at`.
/// 5. `PRAGMA journal_mode = DELETE`, close connection.
/// 6. `F_FULLFSYNC` file, rename `<day>.hot.sqlite` -> `<day>.sqlite`, `fsync` `days/`.
///
/// If `stop_after_step` is `Some(1..=5)`, returns `Ok(false)` immediately after completing
/// that step (used by crash-idempotence tests). Returns `Ok(true)` when fully sealed.
pub fn seal_day_file(
    root: &Path,
    day: &str,
    now_ns: i64,
    catalog: &RwLock<Catalog>,
    reader_pool: Option<&ReaderPool>,
    stop_after_step: Option<u8>,
) -> Result<bool, StoreError> {
    let days_dir = root.join("days");
    let hot_path = days_dir.join(format!("{day}.hot.sqlite"));
    let sealed_path = days_dir.join(format!("{day}.sqlite"));

    if !hot_path.exists() && sealed_path.exists() {
        if let Ok(entry) = inspect_file(&sealed_path, day, false, false) {
            catalog.write().unwrap().days.insert(day.to_owned(), entry);
        }
        return Ok(true);
    }

    // Step 1: Mark day as sealing, evict daemon readers, open connection and set _meta.state = 'sealing'.
    {
        let mut guard = catalog.write().unwrap();
        if let Some(entry) = guard.days.get_mut(day) {
            entry.state = DayFileState::Sealing;
        }
    }
    if let Some(pool) = reader_pool {
        pool.close_all();
    }

    let conn = Connection::open(&hot_path)?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    retry_on_busy(|| {
        conn.execute_batch(
            "PRAGMA fullfsync = ON;
             PRAGMA checkpoint_fullfsync = ON;
             PRAGMA mmap_size = 0;
             PRAGMA cache_size = -2048;",
        )
    })?;
    retry_on_busy(|| {
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('state', 'sealing')",
            [],
        )
    })?;

    if stop_after_step == Some(1) {
        return Ok(false);
    }

    // Step 2: wal_checkpoint(TRUNCATE).
    retry_on_busy(|| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);"))?;

    if stop_after_step == Some(2) {
        return Ok(false);
    }

    // Step 3: quick_check (quarantine as D.corrupt.sqlite on failure).
    let quick_check_result: Result<Vec<String>, rusqlite::Error> = retry_on_busy(|| {
        let mut stmt = conn.prepare("PRAGMA quick_check")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .map_err(|e| match e {
        StoreError::Sqlite(se) => se,
        other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
    });

    let check_ok = match &quick_check_result {
        Ok(lines) => lines.len() == 1 && lines[0].eq_ignore_ascii_case("ok"),
        Err(_) => false,
    };

    if !check_ok {
        let details = match quick_check_result {
            Ok(lines) => lines.join("; "),
            Err(e) => e.to_string(),
        };
        drop(conn);
        quarantine_corrupt_file(&days_dir, day, &hot_path, catalog)?;
        return Err(StoreError::CorruptDayFile {
            day: day.to_owned(),
            details,
        });
    }

    if stop_after_step == Some(3) {
        return Ok(false);
    }

    // Step 4: ANALYZE, set _meta.state = 'sealed' and _meta.sealed_at.
    retry_on_busy(|| conn.execute_batch("ANALYZE;"))?;
    retry_on_busy(|| {
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('state', 'sealed')",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('sealed_at', ?1)",
            params![now_ns],
        )
    })?;

    if stop_after_step == Some(4) {
        return Ok(false);
    }

    // Step 5: journal_mode = DELETE, then close connection so -wal and -shm are removed.
    retry_on_busy(|| conn.execute_batch("PRAGMA journal_mode = DELETE;"))?;
    drop(conn);

    if stop_after_step == Some(5) {
        return Ok(false);
    }

    // Step 6: F_FULLFSYNC the file, rename to D.sqlite, fsync days/.
    full_fsync_file(&hot_path)?;
    fs::rename(&hot_path, &sealed_path)?;
    // Clean up any stray -wal or -shm files if present.
    let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-wal")));
    let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-shm")));
    fsync_dir(&days_dir)?;

    if let Ok(entry) = inspect_file(&sealed_path, day, false, false) {
        catalog.write().unwrap().days.insert(day.to_owned(), entry);
    }
    if let Some(pool) = reader_pool {
        pool.close_all();
    }

    Ok(true)
}

fn quarantine_corrupt_file(
    days_dir: &Path,
    day: &str,
    hot_path: &Path,
    catalog: &RwLock<Catalog>,
) -> Result<(), StoreError> {
    catalog.write().unwrap().days.remove(day);
    let corrupt_path = days_dir.join(format!("{day}.corrupt.sqlite"));
    if hot_path.exists() {
        let _ = fs::rename(hot_path, &corrupt_path);
    }
    let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-wal")));
    let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-shm")));
    let _ = fsync_dir(days_dir);
    Ok(())
}

/// Perform startup recovery (engine.md §3.4):
/// - Delete `*.tmp` in `<root>` and `<root>/days/`, and empty `<root>/trash/`.
/// - If both `<D>.sqlite` and `<D>.sqlz` exist, keep `<D>.sqlz` and unlink `<D>.sqlite`.
/// - Resume the seal of any `<D>.hot.sqlite` older than `today`.
/// - Quarantine any file failing `quick_check` as `<D>.corrupt.sqlite` without blocking startup.
/// - TODO(engine.md §3.4, §4): resume pending `forget` purges recorded in `evidence.sqlite`.
pub fn recover_on_startup(
    root: &Path,
    today: &str,
    now_ns: i64,
    catalog: &RwLock<Catalog>,
    quarantined_out: &mut Vec<String>,
) -> Result<(), StoreError> {
    let days_dir = root.join("days");
    let artifacts_dir = root.join("artifacts");
    let trash_dir = root.join("trash");
    fs::create_dir_all(&days_dir)?;
    fs::create_dir_all(&artifacts_dir)?;
    fs::create_dir_all(&trash_dir)?;

    // 1. Delete *.tmp in root and days/, and empty trash/.
    clean_tmp_files(root)?;
    clean_tmp_files(&days_dir)?;
    empty_dir(&trash_dir)?;

    // 2. If both D.sqlite and D.sqlz exist, keep D.sqlz (engine.md §3.4).
    // TODO(engine.md §2.6): Phase 2 .sqlz reader VFS.
    if let Ok(rd) = fs::read_dir(&days_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                if let Some(day) = fname.strip_suffix(".sqlz") {
                    let sqlite_path = days_dir.join(format!("{day}.sqlite"));
                    if sqlite_path.exists() {
                        let _ = fs::remove_file(sqlite_path);
                    }
                }
            }
        }
    }

    // 3. Resume the seal of any hot file older than today.
    let mut old_hot_days = Vec::new();
    if let Ok(rd) = fs::read_dir(&days_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                if let Some((day, is_hot)) = parse_day_filename(fname) {
                    if is_hot && day.as_str() < today {
                        old_hot_days.push(day);
                    }
                }
            }
        }
    }
    old_hot_days.sort();

    for day in old_hot_days {
        let hot_path = days_dir.join(format!("{day}.hot.sqlite"));
        let sealed_path = days_dir.join(format!("{day}.sqlite"));
        if sealed_path.exists() {
            // If sealed file already exists, verify it; if valid, remove the leftover hot file.
            if verify_quick_check(&sealed_path) {
                let _ = fs::remove_file(&hot_path);
                let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-wal")));
                let _ = fs::remove_file(days_dir.join(format!("{day}.hot.sqlite-shm")));
                continue;
            } else {
                let _ = fs::remove_file(&sealed_path);
            }
        }
        match seal_day_file(root, &day, now_ns, catalog, None, None) {
            Ok(_) => {}
            Err(StoreError::CorruptDayFile { day, .. }) => {
                quarantined_out.push(day);
            }
            Err(_) => {
                let _ = quarantine_corrupt_file(&days_dir, &day, &hot_path, catalog);
                quarantined_out.push(day);
            }
        }
    }

    Ok(())
}

fn verify_quick_check(path: &Path) -> bool {
    let Ok(conn) = Connection::open(path) else {
        return false;
    };
    let Ok(msg) = conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)) else {
        return false;
    };
    msg.eq_ignore_ascii_case("ok")
}

fn clean_tmp_files(dir: &Path) -> Result<(), StoreError> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
            if fname.ends_with(".tmp") {
                let _ = fs::remove_file(&p);
            }
        }
    }
    Ok(())
}

fn empty_dir(dir: &Path) -> Result<(), StoreError> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            let _ = fs::remove_dir_all(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
    }
    Ok(())
}
