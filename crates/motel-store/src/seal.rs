use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection, ErrorCode};

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

/// Atomically rename `from` to `to` without replacing an existing destination file (`docs/engine.md` §2.5).
pub fn rename_no_replace(from: &Path, to: &Path) -> Result<(), StoreError> {
    if to.exists() {
        return Err(StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("destination file already exists: {}", to.display()),
        )));
    }
    #[cfg(target_os = "macos")]
    {
        let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid path bytes",
            ))
        })?;
        let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid path bytes",
            ))
        })?;
        let rc = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
        if rc != 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid path bytes",
            ))
        })?;
        let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid path bytes",
            ))
        })?;
        let rc = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc != 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        fs::hard_link(from, to)?;
        fs::remove_file(from)?;
        Ok(())
    }
}

fn is_sqlite_corruption(err: &StoreError) -> bool {
    match err {
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(ffi_err, _)) => {
            matches!(
                ffi_err.code,
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase
            )
        }
        StoreError::CorruptDayFile { .. } => true,
        _ => false,
    }
}

fn retry_on_busy<T, F: FnMut() -> rusqlite::Result<T>>(mut f: F) -> Result<T, StoreError> {
    let mut attempts = 0;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(rusqlite::Error::SqliteFailure(err, ref msg))
                if (err.code == ErrorCode::DatabaseBusy || err.code == ErrorCode::DatabaseLocked)
                    && attempts < 3 =>
            {
                let _ = msg;
                attempts += 1;
                thread::sleep(Duration::from_millis(10 * attempts));
            }
            Err(e) => return Err(StoreError::Sqlite(e)),
        }
    }
}

fn handle_seal_step_err(
    err: StoreError,
    conn: Connection,
    days_dir: &Path,
    day: &str,
    hot_path: &Path,
    catalog: &RwLock<Catalog>,
) -> StoreError {
    if is_sqlite_corruption(&err) {
        let details = err.to_string();
        // Rename -wal and -shm before dropping `conn` so sqlite3Close cannot unlink them!
        let _ = quarantine_corrupt_file(days_dir, day, hot_path, catalog);
        drop(conn);
        StoreError::CorruptDayFile {
            day: day.to_owned(),
            details,
        }
    } else {
        drop(conn);
        catalog
            .write()
            .unwrap()
            .seal_errors
            .insert(day.to_owned(), err.to_string());
        err
    }
}

/// Seal `<root>/days/<day>.hot.sqlite` in place into `<root>/days/<day>.sqlite` (`docs/engine.md` §2.5).
///
/// Steps (all idempotent):
/// 1. Mark `day` as sealing, close daemon readers, set `_meta.state = 'sealing'`.
/// 2. `PRAGMA wal_checkpoint(TRUNCATE)`.
/// 3. `PRAGMA quick_check` (quarantine as `<day>.corrupt.sqlite` along with `-wal`/`-shm` only on corruption).
/// 4. `ANALYZE`, set `_meta.state = 'sealed'` and `_meta.sealed_at`.
/// 5. `PRAGMA journal_mode = DELETE`, close connection.
/// 6. `F_FULLFSYNC` file, atomically rename `<day>.hot.sqlite` -> `<day>.sqlite` (no-replace), `fsync` `days/`.
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
            let mut guard = catalog.write().unwrap();
            guard.seal_errors.remove(day);
            guard.days.insert(day.to_owned(), entry);
        }
        return Ok(true);
    }

    // Never seal over an already-existing `<day>.sqlite` (Blocker 3).
    if hot_path.exists() && sealed_path.exists() {
        let msg = format!(
            "cannot seal {day}: sealed file {} already exists alongside {}",
            sealed_path.display(),
            hot_path.display()
        );
        let mut guard = catalog.write().unwrap();
        if !guard.conflicting_days.contains(&day.to_owned()) {
            guard.conflicting_days.push(day.to_owned());
        }
        guard.seal_errors.insert(day.to_owned(), msg.clone());
        return Err(StoreError::Other(msg));
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

    let conn = match Connection::open(&hot_path) {
        Ok(c) => c,
        Err(e) => {
            let se = StoreError::Sqlite(e);
            if is_sqlite_corruption(&se) {
                let details = se.to_string();
                quarantine_corrupt_file(&days_dir, day, &hot_path, catalog)?;
                return Err(StoreError::CorruptDayFile {
                    day: day.to_owned(),
                    details,
                });
            }
            catalog
                .write()
                .unwrap()
                .seal_errors
                .insert(day.to_owned(), se.to_string());
            return Err(se);
        }
    };
    conn.busy_timeout(Duration::from_millis(50))?;
    if let Err(e) = retry_on_busy(|| {
        conn.execute_batch(
            "PRAGMA fullfsync = ON;
             PRAGMA checkpoint_fullfsync = ON;
             PRAGMA mmap_size = 0;
             PRAGMA cache_size = -2048;",
        )
    }) {
        return Err(handle_seal_step_err(
            e, conn, &days_dir, day, &hot_path, catalog,
        ));
    }
    if let Err(e) = retry_on_busy(|| {
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('state', 'sealing')",
            [],
        )
    }) {
        return Err(handle_seal_step_err(
            e, conn, &days_dir, day, &hot_path, catalog,
        ));
    }

    if stop_after_step == Some(1) {
        return Ok(false);
    }

    // Pre-checkpoint integrity check: verify `PRAGMA quick_check` before `wal_checkpoint(TRUNCATE)`
    // so that if the file or WAL is corrupt, `-wal` and `-shm` are preserved intact in quarantine.
    let pre_check_lines: Vec<String> = match retry_on_busy(|| {
        let mut stmt = conn.prepare("PRAGMA quick_check")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }) {
        Ok(lines) => lines,
        Err(e) => {
            return Err(handle_seal_step_err(
                e, conn, &days_dir, day, &hot_path, catalog,
            ));
        }
    };
    let pre_check_ok =
        pre_check_lines.len() == 1 && pre_check_lines[0].eq_ignore_ascii_case("ok");
    if !pre_check_ok {
        let details = pre_check_lines.join("; ");
        quarantine_corrupt_file(&days_dir, day, &hot_path, catalog)?;
        drop(conn);
        return Err(StoreError::CorruptDayFile {
            day: day.to_owned(),
            details,
        });
    }

    // Step 2: wal_checkpoint(TRUNCATE).
    // Check the returned `(busy, log, ckpt)` tuple; if `busy != 0`, an external reader holds the WAL.
    let ckpt_tuple: (i64, i64, i64) = match retry_on_busy(|| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
    }) {
        Ok(t) => t,
        Err(e) => {
            return Err(handle_seal_step_err(
                e, conn, &days_dir, day, &hot_path, catalog,
            ));
        }
    };
    if ckpt_tuple.0 != 0 {
        let busy_err = StoreError::Sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            Some("wal_checkpoint(TRUNCATE) blocked by active reader".to_owned()),
        ));
        return Err(handle_seal_step_err(
            busy_err, conn, &days_dir, day, &hot_path, catalog,
        ));
    }

    if stop_after_step == Some(2) {
        return Ok(false);
    }

    // Step 3: quick_check (quarantine as D.corrupt.sqlite ONLY on corruption, never on BUSY/IO).
    let quick_check_lines: Vec<String> = match retry_on_busy(|| {
        let mut stmt = conn.prepare("PRAGMA quick_check")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }) {
        Ok(lines) => lines,
        Err(e) => {
            return Err(handle_seal_step_err(
                e, conn, &days_dir, day, &hot_path, catalog,
            ));
        }
    };

    let check_ok =
        quick_check_lines.len() == 1 && quick_check_lines[0].eq_ignore_ascii_case("ok");
    if !check_ok {
        let details = quick_check_lines.join("; ");
        quarantine_corrupt_file(&days_dir, day, &hot_path, catalog)?;
        drop(conn);
        return Err(StoreError::CorruptDayFile {
            day: day.to_owned(),
            details,
        });
    }

    if stop_after_step == Some(3) {
        return Ok(false);
    }

    // Step 4: ANALYZE, set _meta.state = 'sealed' and _meta.sealed_at.
    if let Err(e) = retry_on_busy(|| conn.execute_batch("ANALYZE;")) {
        return Err(handle_seal_step_err(
            e, conn, &days_dir, day, &hot_path, catalog,
        ));
    }
    if let Err(e) = retry_on_busy(|| {
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('state', 'sealed')",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('sealed_at', ?1)",
            params![now_ns],
        )
    }) {
        return Err(handle_seal_step_err(
            e, conn, &days_dir, day, &hot_path, catalog,
        ));
    }

    if stop_after_step == Some(4) {
        return Ok(false);
    }

    // Step 5: journal_mode = DELETE, then close connection so SQLite removes -wal and -shm cleanly.
    if let Some(pool) = reader_pool {
        pool.close_all();
    }
    if let Err(e) = retry_on_busy(|| conn.execute_batch("PRAGMA journal_mode = DELETE;")) {
        return Err(handle_seal_step_err(
            e, conn, &days_dir, day, &hot_path, catalog,
        ));
    }
    drop(conn);

    if stop_after_step == Some(5) {
        return Ok(false);
    }

    // Step 6: F_FULLFSYNC the file, no-replace rename to D.sqlite, fsync days/.
    full_fsync_file(&hot_path)?;
    rename_no_replace(&hot_path, &sealed_path)?;
    fsync_dir(&days_dir)?;

    if let Ok(entry) = inspect_file(&sealed_path, day, false, false) {
        let mut guard = catalog.write().unwrap();
        guard.seal_errors.remove(day);
        guard.days.insert(day.to_owned(), entry);
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
    {
        let mut guard = catalog.write().unwrap();
        guard.days.remove(day);
        guard.seal_errors.remove(day);
    }
    let corrupt_path = days_dir.join(format!("{day}.corrupt.sqlite"));
    if hot_path.exists() {
        let _ = fs::rename(hot_path, &corrupt_path);
    }
    // Move -wal and -shm alongside the quarantined database; never delete them (Blocker 2).
    let hot_wal = days_dir.join(format!("{day}.hot.sqlite-wal"));
    if hot_wal.exists() {
        let corrupt_wal = days_dir.join(format!("{day}.corrupt.sqlite-wal"));
        let _ = fs::rename(&hot_wal, &corrupt_wal);
    }
    let hot_shm = days_dir.join(format!("{day}.hot.sqlite-shm"));
    if hot_shm.exists() {
        let corrupt_shm = days_dir.join(format!("{day}.corrupt.sqlite-shm"));
        let _ = fs::rename(&hot_shm, &corrupt_shm);
    }
    let _ = fsync_dir(days_dir);
    Ok(())
}

/// Perform startup recovery (`docs/engine.md` §3.4):
/// - Delete `*.tmp` in `<root>` and `<root>/days/`, and empty `<root>/trash/`.
/// - If both `<D>.sqlite` and `<D>.sqlz` exist, keep `<D>.sqlz` and unlink `<D>.sqlite`.
/// - Resume the seal of any `<D>.hot.sqlite` older than `today`.
/// - If both `<D>.hot.sqlite` and `<D>.sqlite` exist for the same day, keep both and report in `conflicts_out`.
/// - Quarantine ONLY files failing `quick_check` with corruption as `<D>.corrupt.sqlite` (moving `-wal`/`-shm` with them).
/// - On `SQLITE_BUSY` or transient I/O errors during startup seal, leave `<D>.hot.sqlite` untouched and record in `deferred_seals_out` for background retry with backoff.
pub fn recover_on_startup(
    root: &Path,
    today: &str,
    now_ns: i64,
    catalog: &RwLock<Catalog>,
    quarantined_out: &mut Vec<String>,
    deferred_seals_out: &mut Vec<String>,
    conflicts_out: &mut Vec<String>,
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

    // 2. If both D.sqlite and D.sqlz exist, keep D.sqlz (docs/engine.md §3.4).
    // TODO(docs/engine.md §2.6): Phase 2 .sqlz reader VFS.
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
    let mut all_hot_days = Vec::new();
    if let Ok(rd) = fs::read_dir(&days_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                if let Some((day, is_hot)) = parse_day_filename(fname) {
                    if is_hot {
                        all_hot_days.push(day);
                    }
                }
            }
        }
    }
    all_hot_days.sort();

    for day in all_hot_days {
        let sealed_path = days_dir.join(format!("{day}.sqlite"));
        if sealed_path.exists() {
            // Never delete a hot file just because a sealed file exists (Blocker 3):
            // keep both on disk and report the conflict.
            if !conflicts_out.contains(&day) {
                conflicts_out.push(day);
            }
            continue;
        }
        if day.as_str() >= today {
            continue;
        }
        match seal_day_file(root, &day, now_ns, catalog, None, None) {
            Ok(_) => {}
            Err(StoreError::CorruptDayFile { day, .. }) => {
                quarantined_out.push(day);
            }
            Err(_) => {
                // Transient error (e.g. SQLITE_BUSY from an external reader): leave the hot file
                // and its -wal/-shm in place and schedule background retry with backoff (Blocker 2).
                deferred_seals_out.push(day);
            }
        }
    }

    Ok(())
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
