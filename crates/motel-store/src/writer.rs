use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::task::{Context as TaskContext, Poll, Waker};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};

use crate::catalog::{
    parse_utc_day_start_ns, utc_day_string, Catalog, CatalogEntry, DayFileState, NS_PER_DAY,
};
use crate::jsonb::{encode_json_str_to_jsonb_buf, ResourceLru};
use crate::reader::ReaderPool;
use crate::schema::{
    base_ddl, configure_checkpointer_conn, configure_evidence_writer_conn,
    configure_hot_writer_conn, init_meta_defaults, read_file_meta, EVIDENCE_EXTRA_DDL,
    MAX_BODY_BYTES,
};
use crate::seal::{seal_day_file, set_background_qos};
use crate::{
    Clock, CommitAck, CursorUpdate, DurabilityMode, Event, Resource, StoreConfig, StoreError,
    SubmitError,
};

/// Shared atomic metrics exposed by the writer and checkpointer for diagnostics and benchmarks (B1).
#[derive(Debug, Default)]
pub struct WriterMetrics {
    pub queued_bytes: AtomicUsize,
    pub peak_queued_bytes: AtomicUsize,
    pub wal_peak_bytes: AtomicU64,
    pub rejected_429_count: AtomicU64,
    pub committed_rows: AtomicU64,
    pub committed_batches: AtomicU64,
    pub committed_txns: AtomicU64,
    pub durable_sync_count: AtomicU64,
    pub writer_insert_cpu_ns: AtomicU64,
    pub checkpoint_cpu_ns: AtomicU64,
    pub nomem_retries: AtomicU64,
}

impl WriterMetrics {
    fn update_peak_queue(&self, cur: usize) {
        let mut prev = self.peak_queued_bytes.load(Ordering::Relaxed);
        while cur > prev {
            match self.peak_queued_bytes.compare_exchange_weak(
                prev,
                cur,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => prev = actual,
            }
        }
    }

    pub fn update_peak_wal(&self, wal_bytes: u64) {
        let mut prev = self.wal_peak_bytes.load(Ordering::Relaxed);
        while wal_bytes > prev {
            match self.wal_peak_bytes.compare_exchange_weak(
                prev,
                wal_bytes,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => prev = actual,
            }
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn clock_gettime_nsec_np(clock_id: libc::clockid_t) -> u64;
    fn malloc_zone_pressure_relief(zone: *mut core::ffi::c_void, goal: usize) -> usize;
}

/// Measure current thread CPU time in nanoseconds on macOS (or 0 on unsupported targets).
#[inline]
pub fn current_thread_cpu_ns() -> u64 {
    #[cfg(target_os = "macos")]
    unsafe {
        clock_gettime_nsec_np(libc::CLOCK_THREAD_CPUTIME_ID)
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Measure current process CPU time in nanoseconds on macOS (or 0 on unsupported targets).
#[inline]
pub fn current_process_cpu_ns() -> u64 {
    #[cfg(target_os = "macos")]
    unsafe {
        clock_gettime_nsec_np(libc::CLOCK_PROCESS_CPUTIME_ID)
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

#[inline]
fn release_allocator_pressure() {
    #[cfg(target_os = "macos")]
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
    }
}

struct AckShared {
    state: Mutex<Option<Result<CommitAck, StoreError>>>,
    cvar: Condvar,
    waker: Mutex<Option<Waker>>,
}

pub(crate) struct AckSender {
    shared: Arc<AckShared>,
    sent: bool,
}

impl AckSender {
    fn send(mut self, res: Result<CommitAck, StoreError>) {
        self.sent = true;
        self.send_inner(res);
    }

    fn send_inner(&self, res: Result<CommitAck, StoreError>) {
        {
            let mut guard = self.shared.state.lock().unwrap();
            *guard = Some(res);
        }
        self.shared.cvar.notify_all();
        if let Some(waker) = self.shared.waker.lock().unwrap().take() {
            waker.wake();
        }
    }
}

impl Drop for AckSender {
    fn drop(&mut self) {
        if !self.sent {
            self.send_inner(Err(StoreError::Closed));
        }
    }
}

/// Handle returned by [`Writer::submit`] that resolves only after the batch's transaction commits
/// (`docs/engine.md` §3.3). Can be awaited as a `Future` or blocked on synchronously via [`Ack::wait`].
pub struct Ack {
    shared: Arc<AckShared>,
}

impl Ack {
    fn pair() -> (AckSender, Ack) {
        let shared = Arc::new(AckShared {
            state: Mutex::new(None),
            cvar: Condvar::new(),
            waker: Mutex::new(None),
        });
        (
            AckSender {
                shared: Arc::clone(&shared),
                sent: false,
            },
            Ack { shared },
        )
    }

    /// Block the current thread until the commit completes and return the [`CommitAck`].
    pub fn wait(self) -> Result<CommitAck, StoreError> {
        let mut guard = self.shared.state.lock().unwrap();
        while guard.is_none() {
            guard = self.shared.cvar.wait(guard).unwrap();
        }
        guard.take().unwrap()
    }

    /// Non-blocking check if the commit has completed.
    pub fn try_recv(&self) -> Option<Result<CommitAck, StoreError>> {
        self.shared.state.lock().unwrap().take()
    }
}

impl Future for Ack {
    type Output = Result<CommitAck, StoreError>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        if let Some(res) = self.shared.state.lock().unwrap().take() {
            return Poll::Ready(res);
        }
        *self.shared.waker.lock().unwrap() = Some(cx.waker().clone());
        if let Some(res) = self.shared.state.lock().unwrap().take() {
            return Poll::Ready(res);
        }
        Poll::Pending
    }
}

struct QueueReservation {
    bytes: usize,
    metrics: Arc<WriterMetrics>,
    space_lock: Arc<(Mutex<()>, Condvar)>,
}

impl QueueReservation {
    fn release(&mut self) {
        if self.bytes > 0 {
            self.metrics
                .queued_bytes
                .fetch_sub(self.bytes, Ordering::Release);
            let (_, cvar) = &*self.space_lock;
            cvar.notify_all();
            self.bytes = 0;
        }
    }
}

impl Drop for QueueReservation {
    fn drop(&mut self) {
        self.release();
    }
}

struct BatchMsg {
    rows: Vec<Event>,
    cursors: Vec<CursorUpdate>,
    bytes: usize,
    reservation: QueueReservation,
    enqueued_at: Instant,
    ack_tx: AckSender,
}

enum WriterCmd {
    Batch(BatchMsg),
    Flush(Sender<Result<(), StoreError>>),
    WaitSeals(Sender<()>),
    Shutdown(Sender<()>),
}

enum CheckpointerCmd {
    NotifyWalSize(u64),
    Stop(Sender<()>),
}

struct CheckpointerHandle {
    tx: Sender<CheckpointerCmd>,
    tx_lock: Arc<Mutex<()>>,
    bytes_since_reset: Arc<AtomicU64>,
    join: Option<JoinHandle<()>>,
}

impl CheckpointerHandle {
    fn spawn(
        hot_path: PathBuf,
        page_size: u32,
        metrics: Arc<WriterMetrics>,
    ) -> Result<Self, StoreError> {
        let (tx, rx) = crossbeam_channel::unbounded::<CheckpointerCmd>();
        let tx_lock = Arc::new(Mutex::new(()));
        let bytes_since_reset = Arc::new(AtomicU64::new(0));
        let lock_clone = Arc::clone(&tx_lock);
        let bytes_clone = Arc::clone(&bytes_since_reset);
        let join = thread::Builder::new()
            .name("motel-ckpt".to_owned())
            .spawn(move || {
                checkpointer_loop(
                    hot_path,
                    page_size,
                    rx,
                    metrics,
                    lock_clone,
                    bytes_clone,
                )
            })
            .map_err(StoreError::Io)?;
        Ok(Self {
            tx,
            tx_lock,
            bytes_since_reset,
            join: Some(join),
        })
    }

    fn record_commit_bytes(&self, commit_bytes: u64) {
        let cur = self
            .bytes_since_reset
            .fetch_add(commit_bytes, Ordering::Relaxed)
            + commit_bytes;
        if cur >= 4 * 1024 * 1024 {
            let _ = self.tx.send(CheckpointerCmd::NotifyWalSize(cur));
        }
    }

    fn stop(&mut self) {
        if let Some(j) = self.join.take() {
            let (tx, rx) = crossbeam_channel::bounded(1);
            let _ = self.tx.send(CheckpointerCmd::Stop(tx));
            let _ = rx.recv_timeout(Duration::from_secs(5));
            let _ = j.join();
        }
    }
}

fn checkpointer_loop(
    hot_path: PathBuf,
    page_size: u32,
    rx: Receiver<CheckpointerCmd>,
    metrics: Arc<WriterMetrics>,
    tx_lock: Arc<Mutex<()>>,
    bytes_since_reset: Arc<AtomicU64>,
) {
    const WAL_PASSIVE_THRESHOLD: u64 = 4 * 1024 * 1024; // 4 MiB (docs/engine.md §3.2)
    const WAL_RESTART_THRESHOLD: u64 = 64 * 1024 * 1024; // 64 MiB (docs/engine.md §3.2)

    let frame_bytes = u64::from(page_size.max(512)) + 24;
    let mut conn: Option<Connection> = None;
    let mut last_passive = Instant::now()
        .checked_sub(Duration::from_secs(10))
        .unwrap_or_else(Instant::now);
    let mut restart_backoff = false;
    let mut has_uncheckpointed = false;
    let mut last_checked_bytes = 0u64;

    loop {
        let cur_tracked = bytes_since_reset.load(Ordering::Relaxed);
        let writer_active =
            cur_tracked >= WAL_PASSIVE_THRESHOLD && (has_uncheckpointed || cur_tracked > last_checked_bytes);
        // Block indefinitely on rx.recv() when idle; run a 1 s timer (or 100 ms backoff)
        // while active with WAL >= 4 MiB (docs/engine.md §3.2).
        let notified_bytes = if !writer_active && !restart_backoff {
            match rx.recv() {
                Ok(CheckpointerCmd::NotifyWalSize(b)) => b,
                Ok(CheckpointerCmd::Stop(ack)) => {
                    drop(conn);
                    let _ = ack.send(());
                    return;
                }
                Err(_) => return,
            }
        } else {
            let wait_dur = if restart_backoff {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(1).saturating_sub(last_passive.elapsed())
            };
            match rx.recv_timeout(wait_dur) {
                Ok(CheckpointerCmd::NotifyWalSize(b)) => b,
                Ok(CheckpointerCmd::Stop(ack)) => {
                    drop(conn);
                    let _ = ack.send(());
                    return;
                }
                Err(RecvTimeoutError::Timeout) => bytes_since_reset.load(Ordering::Relaxed),
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };

        // Drain any queued notifications to use the freshest WAL size.
        let mut wal_bytes = notified_bytes;
        while let Ok(next) = rx.try_recv() {
            match next {
                CheckpointerCmd::NotifyWalSize(b) => wal_bytes = b,
                CheckpointerCmd::Stop(ack) => {
                    drop(conn);
                    let _ = ack.send(());
                    return;
                }
            }
        }

        let active_bytes = bytes_since_reset.load(Ordering::Relaxed).max(wal_bytes);
        if active_bytes < WAL_PASSIVE_THRESHOLD {
            restart_backoff = false;
            has_uncheckpointed = false;
            last_checked_bytes = active_bytes;
            continue;
        }
        let is_over_restart = active_bytes >= WAL_RESTART_THRESHOLD;
        if !is_over_restart && !restart_backoff && last_passive.elapsed() < Duration::from_secs(1) {
            has_uncheckpointed = true;
            continue;
        }

        if conn.is_none() {
            if let Ok(c) = Connection::open(&hot_path) {
                if configure_checkpointer_conn(&c).is_ok() {
                    // Never block on busy locks inside the checkpointer.
                    let _ = c.busy_timeout(Duration::ZERO);
                    conn = Some(c);
                }
            }
        }

        if let Some(c) = &conn {
            let cpu0 = current_thread_cpu_ns();
            // First run PASSIVE concurrently with the writer so bulk frames are copied
            // without blocking writer commits.
            let passive_res: Result<(i64, i64, i64), _> =
                c.query_row("PRAGMA wal_checkpoint(PASSIVE);", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                });
            if let Ok((p_busy, log_frames, ckpt_frames)) = passive_res {
                let actual_wal_bytes = (log_frames.max(0) as u64) * frame_bytes;
                metrics.update_peak_wal(actual_wal_bytes);
                has_uncheckpointed = log_frames > ckpt_frames;

                if actual_wal_bytes >= WAL_RESTART_THRESHOLD {
                    // If the writer appended frames while PASSIVE was running, run one more
                    // PASSIVE pass outside tx_lock so RESTART holds tx_lock as briefly as possible.
                    let mut ready_for_restart = p_busy == 0;
                    if ready_for_restart && (log_frames - ckpt_frames) > 256 {
                        if let Ok((b2, l2, c2)) =
                            c.query_row("PRAGMA wal_checkpoint(PASSIVE);", [], |r| {
                                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                            })
                        {
                            ready_for_restart = b2 == 0;
                            has_uncheckpointed = l2 > c2;
                        }
                    }

                    // Only attempt RESTART under tx_lock if PASSIVE was not blocked by an older reader.
                    if ready_for_restart {
                        let restart_res: Result<(i64, i64, i64), _> = {
                            let _guard = tx_lock.lock().unwrap();
                            c.query_row("PRAGMA wal_checkpoint(RESTART);", [], |r| {
                                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                            })
                        };
                        match restart_res {
                            Ok((0, r_log, r_ckpt)) if r_log == r_ckpt => {
                                bytes_since_reset.store(0, Ordering::Relaxed);
                                last_checked_bytes = 0;
                                has_uncheckpointed = false;
                                restart_backoff = false;
                            }
                            Ok((_, r_log, r_ckpt)) => {
                                let rem = (r_log.max(0) as u64) * frame_bytes;
                                bytes_since_reset.store(rem, Ordering::Relaxed);
                                last_checked_bytes = rem;
                                has_uncheckpointed = r_log > r_ckpt;
                                restart_backoff = true;
                            }
                            Err(_) => {
                                bytes_since_reset.store(actual_wal_bytes, Ordering::Relaxed);
                                last_checked_bytes = actual_wal_bytes;
                                restart_backoff = true;
                            }
                        }
                    } else {
                        bytes_since_reset.store(actual_wal_bytes, Ordering::Relaxed);
                        last_checked_bytes = actual_wal_bytes;
                        restart_backoff = true;
                    }
                } else {
                    restart_backoff = false;
                    bytes_since_reset.store(actual_wal_bytes, Ordering::Relaxed);
                    last_checked_bytes = actual_wal_bytes;
                }
            }
            let cpu_delta = current_thread_cpu_ns().saturating_sub(cpu0);
            metrics
                .checkpoint_cpu_ns
                .fetch_add(cpu_delta, Ordering::Relaxed);
            last_passive = Instant::now();
        }
    }
}

/// Handle to submit normalized events and cursor updates to the single writer thread (`docs/engine.md` §3.1, §3.2).
#[derive(Clone)]
pub struct Writer {
    tx: Sender<WriterCmd>,
    queue_byte_budget: usize,
    metrics: Arc<WriterMetrics>,
    space_lock: Arc<(Mutex<()>, Condvar)>,
}

impl Writer {
    /// Submit a batch of normalized events. Reserves bytes from the 4 MiB queue budget first;
    /// returns [`SubmitError::QueueFull`] (HTTP 429 + `Retry-After: 1`) if full (`docs/engine.md` §3.1).
    pub fn submit(&self, rows: Vec<Event>) -> Result<Ack, SubmitError> {
        self.submit_with_cursors(rows, Vec::new())
    }

    /// Submit a batch of normalized events along with tailer cursor updates to be committed
    /// in the same transaction (`docs/engine.md` §3.2, §3.4).
    pub fn submit_with_cursors(
        &self,
        rows: Vec<Event>,
        cursors: Vec<CursorUpdate>,
    ) -> Result<Ack, SubmitError> {
        let bytes = estimate_batch_bytes(&rows, &cursors);
        let reservation = self.reserve_bytes(bytes, false)?;
        let (ack_tx, ack_rx) = Ack::pair();
        let msg = BatchMsg {
            rows,
            cursors,
            bytes,
            reservation,
            enqueued_at: Instant::now(),
            ack_tx,
        };
        if self.tx.send(WriterCmd::Batch(msg)).is_err() {
            return Err(SubmitError::Closed);
        }
        Ok(ack_rx)
    }

    /// Blocking submit for file tailers, which wait instead of failing with 429 (`docs/engine.md` §3.1).
    /// If a single batch exceeds `queue_byte_budget`, it waits until the queue is empty (`cur == 0`)
    /// and then admits the batch so tailers never spin forever.
    pub fn submit_blocking(
        &self,
        rows: Vec<Event>,
        cursors: Vec<CursorUpdate>,
    ) -> Result<Ack, SubmitError> {
        let bytes = estimate_batch_bytes(&rows, &cursors);
        let reservation = loop {
            match self.reserve_bytes(bytes, true) {
                Ok(res) => break res,
                Err(SubmitError::QueueFull { .. }) => {
                    let (lock, cvar) = &*self.space_lock;
                    let guard = lock.lock().unwrap();
                    if self.metrics.queued_bytes.load(Ordering::Acquire) == 0 {
                        continue;
                    }
                    let _ = cvar.wait_timeout(guard, Duration::from_millis(10)).unwrap();
                }
                Err(e) => return Err(e),
            }
        };
        let (ack_tx, ack_rx) = Ack::pair();
        let msg = BatchMsg {
            rows,
            cursors,
            bytes,
            reservation,
            enqueued_at: Instant::now(),
            ack_tx,
        };
        if self.tx.send(WriterCmd::Batch(msg)).is_err() {
            return Err(SubmitError::Closed);
        }
        Ok(ack_rx)
    }

    /// Immediately commit any pending rows in the writer thread and wait for completion.
    pub fn flush(&self) -> Result<(), StoreError> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(WriterCmd::Flush(tx))
            .map_err(|_| StoreError::Closed)?;
        rx.recv().map_err(|_| StoreError::Closed)?
    }

    /// Wait for any in-flight background day seals to complete.
    pub fn wait_for_seals(&self) -> Result<(), StoreError> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(WriterCmd::WaitSeals(tx))
            .map_err(|_| StoreError::Closed)?;
        rx.recv().map_err(|_| StoreError::Closed)
    }

    pub fn metrics(&self) -> &Arc<WriterMetrics> {
        &self.metrics
    }

    fn reserve_bytes(
        &self,
        bytes: usize,
        allow_oversized_when_empty: bool,
    ) -> Result<QueueReservation, SubmitError> {
        let mut cur = self.metrics.queued_bytes.load(Ordering::Relaxed);
        loop {
            let fits = if allow_oversized_when_empty && cur == 0 {
                true
            } else {
                cur.saturating_add(bytes) <= self.queue_byte_budget
            };
            if !fits {
                if !allow_oversized_when_empty {
                    self.metrics
                        .rejected_429_count
                        .fetch_add(1, Ordering::Relaxed);
                }
                return Err(SubmitError::QueueFull {
                    retry_after_secs: 1,
                });
            }
            match self.metrics.queued_bytes.compare_exchange_weak(
                cur,
                cur + bytes,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    self.metrics.update_peak_queue(cur + bytes);
                    return Ok(QueueReservation {
                        bytes,
                        metrics: Arc::clone(&self.metrics),
                        space_lock: Arc::clone(&self.space_lock),
                    });
                }
                Err(actual) => cur = actual,
            }
        }
    }
}

fn estimate_batch_bytes(rows: &[Event], cursors: &[CursorUpdate]) -> usize {
    let row_bytes: usize = rows.iter().map(Event::estimated_bytes).sum();
    let cur_bytes: usize = cursors
        .iter()
        .map(|c| 64 + c.source.len() + c.head_hash.as_ref().map_or(0, Vec::len))
        .sum();
    (row_bytes + cur_bytes).max(1)
}

pub(crate) struct WriterControl {
    writer: Writer,
    stop_sealers: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WriterControl {
    pub fn spawn(
        config: StoreConfig,
        clock: Arc<dyn Clock>,
        catalog: Arc<RwLock<Catalog>>,
        reader_pool: Arc<ReaderPool>,
        quarantined_days: Arc<Mutex<Vec<String>>>,
        deferred_seal_days: Vec<String>,
    ) -> Result<Self, StoreError> {
        let (tx, rx) = crossbeam_channel::unbounded::<WriterCmd>();
        let metrics = Arc::new(WriterMetrics::default());
        let space_lock = Arc::new((Mutex::new(()), Condvar::new()));
        let stop_sealers = Arc::new(AtomicBool::new(false));

        let state = WriterThreadState::new(
            config.clone(),
            clock,
            catalog,
            reader_pool,
            Arc::clone(&metrics),
            quarantined_days,
            Arc::clone(&stop_sealers),
            deferred_seal_days,
        )?;

        let join = thread::Builder::new()
            .name("motel-writer".to_owned())
            .spawn(move || state.run(rx))
            .map_err(StoreError::Io)?;

        let writer = Writer {
            tx,
            queue_byte_budget: config.queue_byte_budget,
            metrics,
            space_lock,
        };

        Ok(Self {
            writer,
            stop_sealers,
            join: Some(join),
        })
    }

    pub fn handle(&self) -> Writer {
        self.writer.clone()
    }

    pub fn shutdown(&mut self) {
        self.stop_sealers.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let (tx, rx) = crossbeam_channel::bounded(1);
            if self.writer.tx.send(WriterCmd::Shutdown(tx)).is_ok() {
                let _ = rx.recv_timeout(Duration::from_secs(10));
            }
            let _ = join.join();
        }
    }
}

impl Drop for WriterControl {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct OpenTargetFile {
    day: String,
    path: PathBuf,
    conn: Connection,
    lru: ResourceLru,
    min_ts: Option<i64>,
    max_ts: Option<i64>,
    min_ingest_ts: Option<i64>,
    max_ingest_ts: Option<i64>,
    durable_ingest_ts: Option<i64>,
    rows: i64,
    is_evidence: bool,
}

impl OpenTargetFile {
    fn open_hot_day(
        root: &Path,
        day: &str,
        config: &StoreConfig,
        catalog: &RwLock<Catalog>,
    ) -> Result<Self, StoreError> {
        let days_dir = root.join("days");
        fs::create_dir_all(&days_dir)?;
        let path = days_dir.join(format!("{day}.hot.sqlite"));
        let conn = Connection::open(&path)?;
        let sync_full = matches!(config.durability_mode, DurabilityMode::ModeF);
        configure_hot_writer_conn(&conn, config.page_size, sync_full)?;
        let ddl = base_ddl(config.with_ix_req, config.payloads_split);
        conn.execute_batch(&ddl)?;
        init_meta_defaults(&conn, day, &config.machine, "hot")?;
        let meta = read_file_meta(&conn)?;

        let entry = CatalogEntry {
            day: day.to_owned(),
            path: path.clone(),
            state: DayFileState::Hot,
            min_ts: meta.min_ts,
            max_ts: meta.max_ts,
            min_ingest_ts: meta.min_ingest_ts,
            max_ingest_ts: meta.max_ingest_ts,
            durable_ingest_ts: meta.durable_ingest_ts,
            rows: meta.rows,
        };
        catalog.write().unwrap().days.insert(day.to_owned(), entry);

        Ok(Self {
            day: day.to_owned(),
            path,
            conn,
            lru: ResourceLru::new(ResourceLru::DEFAULT_CAPACITY),
            min_ts: meta.min_ts,
            max_ts: meta.max_ts,
            min_ingest_ts: meta.min_ingest_ts,
            max_ingest_ts: meta.max_ingest_ts,
            durable_ingest_ts: meta.durable_ingest_ts,
            rows: meta.rows,
            is_evidence: false,
        })
    }

    fn open_evidence(
        root: &Path,
        config: &StoreConfig,
        catalog: &RwLock<Catalog>,
    ) -> Result<Self, StoreError> {
        let path = root.join("evidence.sqlite");
        let conn = Connection::open(&path)?;
        configure_evidence_writer_conn(&conn, config.page_size)?;
        let mut ddl = base_ddl(config.with_ix_req, config.payloads_split);
        ddl.push_str(EVIDENCE_EXTRA_DDL);
        conn.execute_batch(&ddl)?;
        init_meta_defaults(&conn, "evidence", &config.machine, "hot")?;
        let meta = read_file_meta(&conn)?;

        let entry = CatalogEntry {
            day: "evidence".to_owned(),
            path: path.clone(),
            state: DayFileState::Evidence,
            min_ts: meta.min_ts,
            max_ts: meta.max_ts,
            min_ingest_ts: meta.min_ingest_ts,
            max_ingest_ts: meta.max_ingest_ts,
            durable_ingest_ts: meta.durable_ingest_ts,
            rows: meta.rows,
        };
        catalog.write().unwrap().evidence = Some(entry);

        Ok(Self {
            day: "evidence".to_owned(),
            path,
            conn,
            lru: ResourceLru::new(ResourceLru::DEFAULT_CAPACITY),
            min_ts: meta.min_ts,
            max_ts: meta.max_ts,
            min_ingest_ts: meta.min_ingest_ts,
            max_ingest_ts: meta.max_ingest_ts,
            durable_ingest_ts: meta.durable_ingest_ts,
            rows: meta.rows,
            is_evidence: true,
        })
    }

    fn wal_size_bytes(&self) -> u64 {
        let mut wal_os = self.path.as_os_str().to_owned();
        wal_os.push("-wal");
        let wal_path = PathBuf::from(wal_os);
        fs::metadata(wal_path).map(|m| m.len()).unwrap_or(0)
    }

    fn sync_catalog(&self, catalog: &RwLock<Catalog>) {
        let entry = CatalogEntry {
            day: self.day.clone(),
            path: self.path.clone(),
            state: if self.is_evidence {
                DayFileState::Evidence
            } else {
                DayFileState::Hot
            },
            min_ts: self.min_ts,
            max_ts: self.max_ts,
            min_ingest_ts: self.min_ingest_ts,
            max_ingest_ts: self.max_ingest_ts,
            durable_ingest_ts: self.durable_ingest_ts,
            rows: self.rows,
        };
        let mut guard = catalog.write().unwrap();
        if self.is_evidence {
            guard.evidence = Some(entry);
        } else {
            guard.days.insert(self.day.clone(), entry);
        }
    }
}

struct WriterThreadState {
    config: StoreConfig,
    clock: Arc<dyn Clock>,
    catalog: Arc<RwLock<Catalog>>,
    reader_pool: Arc<ReaderPool>,
    metrics: Arc<WriterMetrics>,
    quarantined_days: Arc<Mutex<Vec<String>>>,
    stop_sealers: Arc<AtomicBool>,
    hot: OpenTargetFile,
    checkpointer: CheckpointerHandle,
    evidence: OpenTargetFile,
    evidence_bytes_since_ckpt: u64,
    last_durable_instant: Instant,
    dirty_since_durable: bool,
    seal_handles: Vec<JoinHandle<()>>,
}

impl WriterThreadState {
    #[allow(clippy::too_many_arguments)]
    fn new(
        config: StoreConfig,
        clock: Arc<dyn Clock>,
        catalog: Arc<RwLock<Catalog>>,
        reader_pool: Arc<ReaderPool>,
        metrics: Arc<WriterMetrics>,
        quarantined_days: Arc<Mutex<Vec<String>>>,
        stop_sealers: Arc<AtomicBool>,
        deferred_seal_days: Vec<String>,
    ) -> Result<Self, StoreError> {
        let now_ns = clock.now_ns();
        let mut active_day = utc_day_string(now_ns);
        // Never step backwards before an already-existing day in the catalog, and never open
        // a hot file for an already-sealed day (Blocker 3).
        {
            let guard = catalog.read().unwrap();
            for existing_day in guard.days.keys() {
                let base_day = existing_day
                    .strip_suffix(".hot")
                    .unwrap_or(existing_day.as_str());
                if base_day > active_day.as_str() {
                    active_day = base_day.to_owned();
                }
            }
        }
        while config
            .root_dir
            .join("days")
            .join(format!("{active_day}.sqlite"))
            .exists()
        {
            if let Some(day_start_ns) = parse_utc_day_start_ns(&active_day) {
                active_day = utc_day_string(day_start_ns + NS_PER_DAY);
            } else {
                break;
            }
        }

        let hot = OpenTargetFile::open_hot_day(&config.root_dir, &active_day, &config, &catalog)?;
        let checkpointer =
            CheckpointerHandle::spawn(hot.path.clone(), config.page_size, Arc::clone(&metrics))?;
        let evidence = OpenTargetFile::open_evidence(&config.root_dir, &config, &catalog)?;

        let mut state = Self {
            config,
            clock,
            catalog,
            reader_pool,
            metrics,
            quarantined_days,
            stop_sealers,
            hot,
            checkpointer,
            evidence,
            evidence_bytes_since_ckpt: 0,
            last_durable_instant: Instant::now(),
            dirty_since_durable: false,
            seal_handles: Vec::new(),
        };

        // Spawn background retry sealers for any prior-day hot files that were BUSY at startup.
        for day in deferred_seal_days {
            if day != state.hot.day {
                let _ = state.spawn_sealer_for_day(&day, now_ns);
            }
        }

        Ok(state)
    }

    fn run(mut self, rx: Receiver<WriterCmd>) {
        let mut pending: Vec<BatchMsg> = Vec::new();
        let mut pending_rows: usize = 0;
        let mut pending_bytes: usize = 0;
        let mut oldest_enqueue: Option<Instant> = None;
        let mut shrunk_since_idle = false;
        let mut last_activity = Instant::now();

        loop {
            // 1. Drain any immediately ready messages up to group commit thresholds.
            let mut flush_waiters: Vec<Sender<Result<(), StoreError>>> = Vec::new();
            let mut seal_waiters: Vec<Sender<()>> = Vec::new();
            let mut shutdown_waiters: Vec<Sender<()>> = Vec::new();

            while pending_rows < self.config.group_commit_max_rows
                && pending_bytes < self.config.group_commit_max_bytes
            {
                match rx.try_recv() {
                    Ok(WriterCmd::Batch(msg)) => {
                        if oldest_enqueue.is_none() {
                            oldest_enqueue = Some(msg.enqueued_at);
                        }
                        pending_rows += msg.rows.len();
                        pending_bytes += msg.bytes;
                        pending.push(msg);
                        shrunk_since_idle = false;
                        last_activity = Instant::now();
                    }
                    Ok(WriterCmd::Flush(tx)) => {
                        flush_waiters.push(tx);
                        break;
                    }
                    Ok(WriterCmd::WaitSeals(tx)) => {
                        seal_waiters.push(tx);
                        break;
                    }
                    Ok(WriterCmd::Shutdown(tx)) => {
                        shutdown_waiters.push(tx);
                        break;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        let (tx, _) = crossbeam_channel::bounded(1);
                        shutdown_waiters.push(tx);
                        break;
                    }
                }
            }

            if !shutdown_waiters.is_empty() {
                self.drain_and_shutdown(
                    &rx,
                    &mut pending,
                    &mut flush_waiters,
                    &mut seal_waiters,
                    &mut shutdown_waiters,
                );
                return;
            }

            // 2. Decide whether to commit now.
            let commit_now = !pending.is_empty()
                && (pending_rows >= self.config.group_commit_max_rows
                    || pending_bytes >= self.config.group_commit_max_bytes
                    || !flush_waiters.is_empty()
                    || !seal_waiters.is_empty()
                    || oldest_enqueue
                        .is_some_and(|t| t.elapsed() >= self.config.group_commit_interval));

            if commit_now {
                let res = self.commit_group(&mut pending);
                debug_assert!(pending.is_empty());
                pending_rows = 0;
                pending_bytes = 0;
                oldest_enqueue = None;
                for tx in flush_waiters.drain(..) {
                    let _ = tx.send(
                        res.as_ref()
                            .copied()
                            .map_err(|e| StoreError::Other(e.to_string())),
                    );
                }
            } else if !flush_waiters.is_empty() {
                // Even if pending was empty, check if day rolled or Mode T dirty needs flush.
                let res = self.maybe_roll_day_and_heartbeat(true);
                for tx in flush_waiters.drain(..) {
                    let _ = tx.send(
                        res.as_ref()
                            .copied()
                            .map_err(|e| StoreError::Other(e.to_string())),
                    );
                }
            }

            if !seal_waiters.is_empty() {
                let _ = self.maybe_roll_day_and_heartbeat(false);
                self.join_seals();
                for tx in seal_waiters.drain(..) {
                    let _ = tx.send(());
                }
            }

            // 3. Compute next timeout:
            // - If pending batches exist: wait until oldest_enqueue + group_commit_interval.
            // - Else if Mode T and dirty_since_durable: wait until last_durable_instant + 1s.
            // - Else if !shrunk_since_idle: wait until last_activity + 30s to shrink_memory (§5).
            // - Else: block indefinitely on rx.recv() (zero timers at idle, §3.2).
            let next_timeout: Option<Duration> = if let Some(oldest) = oldest_enqueue {
                Some(
                    self.config
                        .group_commit_interval
                        .saturating_sub(oldest.elapsed()),
                )
            } else if matches!(self.config.durability_mode, DurabilityMode::ModeT)
                && self.dirty_since_durable
            {
                Some(
                    Duration::from_secs(1)
                        .saturating_sub(self.last_durable_instant.elapsed()),
                )
            } else if !shrunk_since_idle {
                Some(Duration::from_secs(30).saturating_sub(last_activity.elapsed()))
            } else {
                None
            };

            match next_timeout {
                Some(timeout) => match rx.recv_timeout(timeout) {
                    Ok(WriterCmd::Batch(msg)) => {
                        if oldest_enqueue.is_none() {
                            oldest_enqueue = Some(msg.enqueued_at);
                        }
                        pending_rows += msg.rows.len();
                        pending_bytes += msg.bytes;
                        pending.push(msg);
                        shrunk_since_idle = false;
                        last_activity = Instant::now();
                    }
                    Ok(WriterCmd::Flush(tx)) => {
                        let res = if !pending.is_empty() {
                            let r = self.commit_group(&mut pending);
                            debug_assert!(pending.is_empty());
                            pending_rows = 0;
                            pending_bytes = 0;
                            oldest_enqueue = None;
                            r
                        } else {
                            self.maybe_roll_day_and_heartbeat(true)
                        };
                        let _ = tx.send(res);
                    }
                    Ok(WriterCmd::WaitSeals(tx)) => {
                        if !pending.is_empty() {
                            let _ = self.commit_group(&mut pending);
                            debug_assert!(pending.is_empty());
                            pending_rows = 0;
                            pending_bytes = 0;
                            oldest_enqueue = None;
                        }
                        let _ = self.maybe_roll_day_and_heartbeat(false);
                        self.join_seals();
                        let _ = tx.send(());
                    }
                    Ok(WriterCmd::Shutdown(tx)) => {
                        shutdown_waiters.push(tx);
                        self.drain_and_shutdown(
                            &rx,
                            &mut pending,
                            &mut flush_waiters,
                            &mut seal_waiters,
                            &mut shutdown_waiters,
                        );
                        return;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            if matches!(self.config.durability_mode, DurabilityMode::ModeT)
                                && self.dirty_since_durable
                                && self.last_durable_instant.elapsed() >= Duration::from_secs(1)
                            {
                                let _ = self.run_durable_heartbeat();
                            } else if !shrunk_since_idle
                                && last_activity.elapsed() >= Duration::from_secs(30)
                            {
                                // Shrink writer page cache and checkpoint evidence after 30 s idle (docs/engine.md §5).
                                self.checkpoint_evidence();
                                let _ = self.hot.conn.execute_batch("PRAGMA shrink_memory;");
                                let _ = self.evidence.conn.execute_batch("PRAGMA shrink_memory;");
                                let _ = self.hot.conn.release_memory();
                                let _ = self.evidence.conn.release_memory();
                                self.reader_pool.close_all();
                                unsafe {
                                    rusqlite::ffi::sqlite3_release_memory(i32::MAX);
                                }
                                release_allocator_pressure();
                                shrunk_since_idle = true;
                            }
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        self.drain_and_shutdown(
                            &rx,
                            &mut pending,
                            &mut flush_waiters,
                            &mut seal_waiters,
                            &mut shutdown_waiters,
                        );
                        return;
                    }
                },
                None => match rx.recv() {
                    Ok(WriterCmd::Batch(msg)) => {
                        oldest_enqueue = Some(msg.enqueued_at);
                        pending_rows += msg.rows.len();
                        pending_bytes += msg.bytes;
                        pending.push(msg);
                        shrunk_since_idle = false;
                        last_activity = Instant::now();
                    }
                    Ok(WriterCmd::Flush(tx)) => {
                        let res = self.maybe_roll_day_and_heartbeat(true);
                        let _ = tx.send(res);
                    }
                    Ok(WriterCmd::WaitSeals(tx)) => {
                        let _ = self.maybe_roll_day_and_heartbeat(false);
                        self.join_seals();
                        let _ = tx.send(());
                    }
                    Ok(WriterCmd::Shutdown(tx)) => {
                        shutdown_waiters.push(tx);
                        self.drain_and_shutdown(
                            &rx,
                            &mut pending,
                            &mut flush_waiters,
                            &mut seal_waiters,
                            &mut shutdown_waiters,
                        );
                        return;
                    }
                    Err(_) => {
                        self.drain_and_shutdown(
                            &rx,
                            &mut pending,
                            &mut flush_waiters,
                            &mut seal_waiters,
                            &mut shutdown_waiters,
                        );
                        return;
                    }
                },
            }
        }
    }

    fn drain_and_shutdown(
        &mut self,
        rx: &Receiver<WriterCmd>,
        pending: &mut Vec<BatchMsg>,
        flush_waiters: &mut Vec<Sender<Result<(), StoreError>>>,
        seal_waiters: &mut Vec<Sender<()>>,
        shutdown_waiters: &mut Vec<Sender<()>>,
    ) {
        let mut last_res: Result<(), StoreError> = Ok(());
        // Drain every command remaining in the channel so no queued batch is ever lost or left hanging.
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                WriterCmd::Batch(msg) => {
                    pending.push(msg);
                    if pending.len() >= self.config.group_commit_max_rows {
                        last_res = self.commit_group(pending);
                    }
                }
                WriterCmd::Flush(tx) => flush_waiters.push(tx),
                WriterCmd::WaitSeals(tx) => seal_waiters.push(tx),
                WriterCmd::Shutdown(tx) => shutdown_waiters.push(tx),
            }
        }
        if !pending.is_empty() {
            last_res = self.commit_group(pending);
        }
        let roll_res = self.maybe_roll_day_and_heartbeat(true);
        if last_res.is_ok() {
            last_res = roll_res;
        }
        self.checkpoint_evidence();
        for tx in flush_waiters.drain(..) {
            let _ = tx.send(
                last_res
                    .as_ref()
                    .copied()
                    .map_err(|e| StoreError::Other(e.to_string())),
            );
        }
        self.stop_sealers.store(true, Ordering::Release);
        self.join_seals();
        for tx in seal_waiters.drain(..) {
            let _ = tx.send(());
        }
        self.checkpointer.stop();
        for tx in shutdown_waiters.drain(..) {
            let _ = tx.send(());
        }
    }

    fn join_seals(&mut self) {
        for h in self.seal_handles.drain(..) {
            let _ = h.join();
        }
    }

    fn checkpoint_evidence(&mut self) {
        let _ = self.evidence.conn.busy_timeout(Duration::ZERO);
        let res: Result<(i64, i64, i64), _> =
            self.evidence
                .conn
                .query_row("PRAGMA wal_checkpoint(PASSIVE);", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                });
        if let Ok((busy, log_frames, _)) = res {
            if busy == 0 && log_frames > 0 {
                let _ = self
                    .evidence
                    .conn
                    .execute_batch("PRAGMA wal_checkpoint(RESTART);");
            }
            self.evidence_bytes_since_ckpt = 0;
        }
        let _ = self.evidence.conn.busy_timeout(Duration::from_millis(5000));
    }

    fn maybe_roll_day_and_heartbeat(&mut self, force_durable: bool) -> Result<(), StoreError> {
        let now_ns = self.clock.now_ns();
        let arrival_day = utc_day_string(now_ns);
        // Roll forward only: never roll backwards if the clock steps back across midnight (Blocker 3).
        if arrival_day.as_str() > self.hot.day.as_str() {
            self.roll_day(&arrival_day, now_ns)?;
        }
        if force_durable && self.dirty_since_durable {
            self.run_durable_heartbeat()?;
        }
        Ok(())
    }

    fn roll_day(&mut self, new_day: &str, now_ns: i64) -> Result<(), StoreError> {
        if new_day <= self.hot.day.as_str() {
            return Ok(());
        }
        // Ensure any dirty WAL on the old day is durable before sealing; propagate errors (Should-fix 6).
        if self.dirty_since_durable {
            self.run_durable_heartbeat()?;
        }

        let old_day = self.hot.day.clone();
        // Replace checkpointer and hot connection with the new day first.
        let new_hot =
            OpenTargetFile::open_hot_day(&self.config.root_dir, new_day, &self.config, &self.catalog)?;
        let new_ckpt = CheckpointerHandle::spawn(
            new_hot.path.clone(),
            self.config.page_size,
            Arc::clone(&self.metrics),
        )?;

        let old_hot = std::mem::replace(&mut self.hot, new_hot);
        let mut old_ckpt = std::mem::replace(&mut self.checkpointer, new_ckpt);
        old_ckpt.stop();
        drop(old_hot);

        self.spawn_sealer_for_day(&old_day, now_ns)
    }

    fn spawn_sealer_for_day(&mut self, old_day: &str, now_ns: i64) -> Result<(), StoreError> {
        let root_dir = self.config.root_dir.clone();
        let catalog = Arc::clone(&self.catalog);
        let reader_pool = Arc::clone(&self.reader_pool);
        let quarantined_days = Arc::clone(&self.quarantined_days);
        let stop_sealers = Arc::clone(&self.stop_sealers);
        let stop_after_step = self.config.seal_stop_after_step;
        let day_owned = old_day.to_owned();

        let handle = thread::Builder::new()
            .name(format!("motel-seal-{day_owned}"))
            .spawn(move || {
                set_background_qos();
                let mut attempt = 0u64;
                loop {
                    match seal_day_file(
                        &root_dir,
                        &day_owned,
                        now_ns,
                        &catalog,
                        Some(&reader_pool),
                        stop_after_step,
                    ) {
                        Ok(_) => break,
                        Err(StoreError::CorruptDayFile { day, .. }) => {
                            let mut q = quarantined_days.lock().unwrap();
                            if !q.contains(&day) {
                                q.push(day);
                            }
                            break;
                        }
                        Err(_) => {
                            // If a sealed file already exists alongside the hot file, do not spin.
                            if root_dir
                                .join("days")
                                .join(format!("{day_owned}.sqlite"))
                                .exists()
                            {
                                break;
                            }
                            if stop_sealers.load(Ordering::Acquire) {
                                break;
                            }
                            attempt = (attempt + 1).min(8);
                            thread::sleep(Duration::from_millis(25 * attempt));
                        }
                    }
                }
            })
            .map_err(StoreError::Io)?;
        self.seal_handles.push(handle);
        Ok(())
    }

    fn run_durable_heartbeat(&mut self) -> Result<(), StoreError> {
        let Some(max_ingest) = self.hot.max_ingest_ts else {
            self.dirty_since_durable = false;
            return Ok(());
        };
        let cpu0 = current_thread_cpu_ns();
        let tx_lock = Arc::clone(&self.checkpointer.tx_lock);
        let _tx_guard = tx_lock.lock().unwrap();

        self.hot.conn.execute_batch("PRAGMA synchronous = FULL;")?;
        let tx_res = (|| -> rusqlite::Result<()> {
            self.hot.conn.execute_batch("BEGIN IMMEDIATE;")?;
            self.hot.conn.execute(
                "INSERT OR REPLACE INTO _meta (k, v) VALUES ('durable_ingest_ts', ?1)",
                params![max_ingest],
            )?;
            self.hot.conn.execute_batch("COMMIT;")?;
            Ok(())
        })();
        if tx_res.is_err() {
            let _ = self.hot.conn.execute_batch("ROLLBACK;");
        }
        if matches!(self.config.durability_mode, DurabilityMode::ModeT) {
            let _ = self.hot.conn.execute_batch("PRAGMA synchronous = NORMAL;");
        }
        tx_res?;
        let cpu_delta = current_thread_cpu_ns().saturating_sub(cpu0);
        self.metrics
            .writer_insert_cpu_ns
            .fetch_add(cpu_delta, Ordering::Relaxed);
        self.metrics
            .durable_sync_count
            .fetch_add(1, Ordering::Relaxed);
        self.hot.durable_ingest_ts = Some(max_ingest);
        self.hot.sync_catalog(&self.catalog);
        self.dirty_since_durable = false;
        self.last_durable_instant = Instant::now();
        Ok(())
    }

    fn fail_all_batches(batches: &mut Vec<BatchMsg>, err_msg: &str) {
        for mut b in batches.drain(..) {
            b.reservation.release();
            b.ack_tx.send(Err(StoreError::Other(err_msg.to_owned())));
        }
    }

    fn commit_group(&mut self, batches: &mut Vec<BatchMsg>) -> Result<(), StoreError> {
        if self.config.take_injected_commit_failure() {
            let msg = "injected commit failure".to_owned();
            Self::fail_all_batches(batches, &msg);
            return Err(StoreError::Other(msg));
        }

        let now_ns = self.clock.now_ns();
        let arrival_day = utc_day_string(now_ns);
        // Roll forward only (Blocker 3); on roll_day failure, ack every pending batch with Err (Blocker 1).
        if arrival_day.as_str() > self.hot.day.as_str() {
            if let Err(e) = self.roll_day(&arrival_day, now_ns) {
                let msg = format!("day roll failed: {e}");
                Self::fail_all_batches(batches, &msg);
                return Err(e);
            }
        }

        let n_batches = batches.len();
        let mut batch_errors: Vec<Option<String>> = vec![None; n_batches];

        let mut hot_batch_indices: Vec<usize> = Vec::new();
        let mut ev_batch_indices: Vec<usize> = Vec::new();
        let mut hot_rows: Vec<&Event> = Vec::new();
        let mut hot_cursors: Vec<&CursorUpdate> = Vec::new();
        let mut hot_bytes = 0usize;

        for (idx, b) in batches.iter().enumerate() {
            let mut b_has_hot = false;
            let mut b_has_ev = false;
            for r in &b.rows {
                if r.is_evidence() {
                    b_has_ev = true;
                } else {
                    b_has_hot = true;
                }
            }
            for c in &b.cursors {
                if c.is_evidence {
                    b_has_ev = true;
                } else {
                    b_has_hot = true;
                }
            }
            // Only pre-validate in Rust when a single batch spans both hot and evidence files;
            // otherwise SQLite's `jsonb(?)` (or `direct_jsonb` in `try_commit_once`) validates
            // during INSERT and the per-batch fallback below isolates any bad batch without
            // parsing JSON twice on the normal fast path.
            if b_has_hot && b_has_ev {
                if let Err(reason) = validate_batch_attrs(b, self.config.direct_jsonb) {
                    batch_errors[idx] = Some(reason);
                    continue;
                }
            }
            for r in &b.rows {
                if !r.is_evidence() {
                    hot_rows.push(r);
                }
            }
            for c in &b.cursors {
                if !c.is_evidence {
                    hot_cursors.push(c);
                }
            }
            if b_has_hot {
                hot_batch_indices.push(idx);
                hot_bytes += b.bytes;
            }
            if b_has_ev {
                ev_batch_indices.push(idx);
            }
        }

        let cpu0 = current_thread_cpu_ns();
        let mut committed_hot_rows = 0u64;
        let mut committed_ev_rows = 0u64;

        // 1. Commit hot day rows and cursors.
        if !hot_rows.is_empty() || !hot_cursors.is_empty() {
            let run_full_sync = match self.config.durability_mode {
                DurabilityMode::ModeF => true,
                DurabilityMode::ModeT => {
                    self.last_durable_instant.elapsed() >= Duration::from_secs(1)
                }
            };

            let group_hot_res = {
                let tx_lock = Arc::clone(&self.checkpointer.tx_lock);
                let _tx_guard = tx_lock.lock().unwrap();
                self.commit_to_target(false, &hot_rows, &hot_cursors, now_ns, run_full_sync)
            };

            match group_hot_res {
                Ok(()) => {
                    committed_hot_rows = hot_rows.len() as u64;
                    if run_full_sync {
                        self.last_durable_instant = Instant::now();
                        self.dirty_since_durable = false;
                        self.metrics
                            .durable_sync_count
                            .fetch_add(1, Ordering::Relaxed);
                    } else {
                        self.dirty_since_durable = true;
                    }
                    let wal_bytes = self.hot.wal_size_bytes();
                    self.metrics.update_peak_wal(wal_bytes);
                    self.checkpointer.record_commit_bytes(hot_bytes as u64);
                    self.metrics.committed_txns.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) if hot_batch_indices.len() <= 1 => {
                    for &idx in &hot_batch_indices {
                        batch_errors[idx] = Some(format!("hot commit failed: {e}"));
                    }
                }
                Err(_) => {
                    // Fallback: commit each hot batch individually so one failing batch doesn't
                    // reject other clients' batches in the group (Should-fix 8).
                    for &idx in &hot_batch_indices {
                        let b = &batches[idx];
                        let b_rows: Vec<&Event> =
                            b.rows.iter().filter(|r| !r.is_evidence()).collect();
                        let b_curs: Vec<&CursorUpdate> =
                            b.cursors.iter().filter(|c| !c.is_evidence).collect();
                        let res = {
                            let tx_lock = Arc::clone(&self.checkpointer.tx_lock);
                            let _tx_guard = tx_lock.lock().unwrap();
                            self.commit_to_target(false, &b_rows, &b_curs, now_ns, run_full_sync)
                        };
                        match res {
                            Ok(()) => {
                                committed_hot_rows += b_rows.len() as u64;
                                self.dirty_since_durable = !run_full_sync;
                                self.checkpointer.record_commit_bytes(b.bytes as u64);
                                self.metrics.committed_txns.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(err) => {
                                batch_errors[idx] = Some(format!("hot commit failed: {err}"));
                            }
                        }
                    }
                }
            }
        }

        // 2. Commit evidence.sqlite rows and cursors for batches whose hot part (if any) succeeded.
        ev_batch_indices.retain(|&idx| batch_errors[idx].is_none());
        if !ev_batch_indices.is_empty() {
            if self.config.take_injected_evidence_failure() {
                for &idx in &ev_batch_indices {
                    batch_errors[idx] = Some("injected evidence commit failure".to_owned());
                }
            } else {
                let mut ev_rows: Vec<&Event> = Vec::new();
                let mut ev_cursors: Vec<&CursorUpdate> = Vec::new();
                let mut ev_bytes = 0u64;
                for &idx in &ev_batch_indices {
                    let b = &batches[idx];
                    ev_bytes += b.bytes as u64;
                    for r in &b.rows {
                        if r.is_evidence() {
                            ev_rows.push(r);
                        }
                    }
                    for c in &b.cursors {
                        if c.is_evidence {
                            ev_cursors.push(c);
                        }
                    }
                }

                let group_ev_res =
                    self.commit_to_target(true, &ev_rows, &ev_cursors, now_ns, true);
                match group_ev_res {
                    Ok(()) => {
                        committed_ev_rows = ev_rows.len() as u64;
                        self.evidence_bytes_since_ckpt += ev_bytes;
                        if self.evidence_bytes_since_ckpt >= 4 * 1024 * 1024 {
                            self.checkpoint_evidence();
                        }
                        if hot_rows.is_empty() && hot_cursors.is_empty() {
                            self.metrics.committed_txns.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Err(e) if ev_batch_indices.len() <= 1 => {
                        for &idx in &ev_batch_indices {
                            batch_errors[idx] = Some(format!("evidence commit failed: {e}"));
                        }
                    }
                    Err(_) => {
                        for &idx in &ev_batch_indices {
                            let b = &batches[idx];
                            let b_rows: Vec<&Event> =
                                b.rows.iter().filter(|r| r.is_evidence()).collect();
                            let b_curs: Vec<&CursorUpdate> =
                                b.cursors.iter().filter(|c| c.is_evidence).collect();
                            match self.commit_to_target(true, &b_rows, &b_curs, now_ns, true) {
                                Ok(()) => {
                                    committed_ev_rows += b_rows.len() as u64;
                                    self.evidence_bytes_since_ckpt += b.bytes as u64;
                                }
                                Err(err) => {
                                    batch_errors[idx] =
                                        Some(format!("evidence commit failed: {err}"));
                                }
                            }
                        }
                    }
                }
            }
        }

        let cpu_delta = current_thread_cpu_ns().saturating_sub(cpu0);
        self.metrics
            .writer_insert_cpu_ns
            .fetch_add(cpu_delta, Ordering::Relaxed);

        let total_committed_rows = committed_hot_rows + committed_ev_rows;
        self.metrics
            .committed_rows
            .fetch_add(total_committed_rows, Ordering::Relaxed);

        // Acknowledge each batch according to whether its own target file(s) committed (Should-fix 8).
        let day_name = self.hot.day.clone();
        let mut first_err: Option<StoreError> = None;
        let mut ok_batches = 0u64;

        for (idx, mut b) in batches.drain(..).enumerate() {
            b.reservation.release();
            let n = b.rows.len();
            match &batch_errors[idx] {
                None => {
                    ok_batches += 1;
                    b.ack_tx.send(Ok(CommitAck {
                        day: day_name.clone(),
                        rows_committed: n,
                        ingest_ts: now_ns,
                    }));
                }
                Some(err_msg) => {
                    if first_err.is_none() {
                        first_err = Some(StoreError::Other(err_msg.clone()));
                    }
                    b.ack_tx.send(Err(StoreError::Other(err_msg.clone())));
                }
            }
        }

        self.metrics
            .committed_batches
            .fetch_add(ok_batches, Ordering::Relaxed);

        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn commit_to_target(
        &mut self,
        is_evidence: bool,
        rows: &[&Event],
        cursors: &[&CursorUpdate],
        now_ns: i64,
        run_full_sync: bool,
    ) -> Result<(), StoreError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let res = self.try_commit_once(is_evidence, rows, cursors, now_ns, run_full_sync);
            match res {
                Ok(()) => return Ok(()),
                Err(rusqlite::Error::SqliteFailure(err, _))
                    if err.code == ErrorCode::OutOfMemory && attempt == 1 =>
                {
                    // On SQLITE_NOMEM the writer closes every reader (including active sql() queries)
                    // and retries the batch once (docs/engine.md §2.2).
                    self.metrics.nomem_retries.fetch_add(1, Ordering::Relaxed);
                    self.reader_pool.close_all();
                    let _ = self.hot.conn.release_memory();
                    let _ = self.evidence.conn.release_memory();
                    unsafe {
                        rusqlite::ffi::sqlite3_release_memory(i32::MAX);
                    }
                    continue;
                }
                Err(e) => return Err(StoreError::Sqlite(e)),
            }
        }
    }

    fn try_commit_once(
        &mut self,
        is_evidence: bool,
        rows: &[&Event],
        cursors: &[&CursorUpdate],
        now_ns: i64,
        run_full_sync: bool,
    ) -> rusqlite::Result<()> {
        let target = if is_evidence {
            &mut self.evidence
        } else {
            &mut self.hot
        };

        let toggle_sync = !is_evidence
            && matches!(self.config.durability_mode, DurabilityMode::ModeT)
            && run_full_sync;

        if toggle_sync {
            target.conn.execute_batch("PRAGMA synchronous = FULL;")?;
        }

        let tx_res = (|| -> rusqlite::Result<()> {
            target.conn.execute_batch("BEGIN IMMEDIATE;")?;

            let mut batch_min_ts = target.min_ts.unwrap_or(i64::MAX);
            let mut batch_max_ts = target.max_ts.unwrap_or(i64::MIN);
            // Writer always stamps ingest_ts from its own clock (Should-fix 13).
            let ingest_ts = now_ns;
            let batch_min_ingest = target.min_ingest_ts.unwrap_or(i64::MAX).min(ingest_ts);
            let batch_max_ingest = target.max_ingest_ts.unwrap_or(i64::MIN).max(ingest_ts);

            let insert_sql = if self.config.payloads_split {
                "INSERT INTO events (
                    ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact, body, attrs
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, NULL
                 )"
            } else if self.config.direct_jsonb {
                "INSERT INTO events (
                    ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact, body, attrs
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
                 )"
            } else {
                "INSERT INTO events (
                    ts, ingest_ts, dur, kind, service, severity, status, err, name,
                    trace_id, span_id, parent_id, session_id, request_id, res, src, artifact, body, attrs
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, jsonb(?19)
                 )"
            };

            {
                let mut ins_stmt = target.conn.prepare_cached(insert_sql)?;
                let mut payload_stmt = if self.config.payloads_split {
                    Some(target.conn.prepare_cached(
                        "INSERT INTO payloads (id, body, attrs) VALUES (?1, ?2, jsonb(?3))",
                    )?)
                } else {
                    None
                };
                let mut jsonb_buf = Vec::with_capacity(512);

                for ev in rows {
                    batch_min_ts = batch_min_ts.min(ev.ts);
                    batch_max_ts = batch_max_ts.max(ev.ts);

                    let res_id = match &ev.resource {
                        Some(res) => Some(intern_resource(&target.conn, &mut target.lru, res)?),
                        None => None,
                    };

                    let capped_body = ev.body.as_deref().map(cap_utf8_16k);
                    let err_flag: i64 = i64::from(ev.compute_err());
                    let trace_slice = ev.trace_id.as_ref().map(|b| b.as_slice());
                    let span_slice = ev.span_id.as_ref().map(|b| b.as_slice());
                    let parent_slice = ev.parent_id.as_ref().map(|b| b.as_slice());

                    if self.config.payloads_split {
                        ins_stmt.execute(params![
                            ev.ts,
                            ingest_ts,
                            ev.dur,
                            ev.kind.as_str(),
                            ev.service.as_str(),
                            ev.severity,
                            ev.status.as_deref(),
                            err_flag,
                            ev.name.as_deref(),
                            trace_slice,
                            span_slice,
                            parent_slice,
                            ev.session_id.as_deref(),
                            ev.request_id.as_deref(),
                            res_id,
                            ev.src as i64,
                            ev.artifact.as_deref(),
                        ])?;
                        let rowid = target.conn.last_insert_rowid();
                        if let Some(ps) = &mut payload_stmt {
                            ps.execute(params![rowid, capped_body, ev.attrs.as_deref()])?;
                        }
                    } else if self.config.direct_jsonb {
                        let jsonb_slice: Option<&[u8]> = match ev.attrs.as_deref() {
                            Some(s) => {
                                if !encode_json_str_to_jsonb_buf(s, &mut jsonb_buf) {
                                    return Err(rusqlite::Error::ToSqlConversionFailure(
                                        "invalid JSON in event attrs".into(),
                                    ));
                                }
                                Some(jsonb_buf.as_slice())
                            }
                            None => None,
                        };
                        ins_stmt.execute(params![
                            ev.ts,
                            ingest_ts,
                            ev.dur,
                            ev.kind.as_str(),
                            ev.service.as_str(),
                            ev.severity,
                            ev.status.as_deref(),
                            err_flag,
                            ev.name.as_deref(),
                            trace_slice,
                            span_slice,
                            parent_slice,
                            ev.session_id.as_deref(),
                            ev.request_id.as_deref(),
                            res_id,
                            ev.src as i64,
                            ev.artifact.as_deref(),
                            capped_body,
                            jsonb_slice,
                        ])?;
                    } else {
                        ins_stmt.execute(params![
                            ev.ts,
                            ingest_ts,
                            ev.dur,
                            ev.kind.as_str(),
                            ev.service.as_str(),
                            ev.severity,
                            ev.status.as_deref(),
                            err_flag,
                            ev.name.as_deref(),
                            trace_slice,
                            span_slice,
                            parent_slice,
                            ev.session_id.as_deref(),
                            ev.request_id.as_deref(),
                            res_id,
                            ev.src as i64,
                            ev.artifact.as_deref(),
                            capped_body,
                            ev.attrs.as_deref(),
                        ])?;
                    }
                }
            }

            if !cursors.is_empty() {
                let mut cur_stmt = target.conn.prepare_cached(
                    "INSERT OR REPLACE INTO cursors (source, dev, ino, head_hash, offset, updated_ingest_ts)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?;
                for c in cursors {
                    let cur_ts = if c.updated_ingest_ts > 0 {
                        c.updated_ingest_ts
                    } else {
                        ingest_ts
                    };
                    cur_stmt.execute(params![
                        c.source.as_str(),
                        c.dev,
                        c.ino,
                        c.head_hash.as_deref(),
                        c.offset,
                        cur_ts,
                    ])?;
                }
            }

            let new_rows = target.rows + (rows.len() as i64);
            if !rows.is_empty() {
                let mut meta_stmt = target
                    .conn
                    .prepare_cached("INSERT OR REPLACE INTO _meta (k, v) VALUES (?1, ?2)")?;
                meta_stmt.execute(params!["min_ts", batch_min_ts])?;
                meta_stmt.execute(params!["max_ts", batch_max_ts])?;
                meta_stmt.execute(params!["min_ingest_ts", batch_min_ingest])?;
                meta_stmt.execute(params!["max_ingest_ts", batch_max_ingest])?;
                meta_stmt.execute(params!["rows", new_rows])?;
                if run_full_sync {
                    meta_stmt.execute(params!["durable_ingest_ts", batch_max_ingest])?;
                }
            }

            target.conn.execute_batch("COMMIT;")?;

            if !rows.is_empty() {
                target.min_ts = Some(batch_min_ts);
                target.max_ts = Some(batch_max_ts);
                target.min_ingest_ts = Some(batch_min_ingest);
                target.max_ingest_ts = Some(batch_max_ingest);
                target.rows = new_rows;
                if run_full_sync {
                    target.durable_ingest_ts = Some(batch_max_ingest);
                }
            }

            Ok(())
        })();

        if tx_res.is_err() {
            let _ = target.conn.execute_batch("ROLLBACK;");
        }

        if toggle_sync {
            let _ = target.conn.execute_batch("PRAGMA synchronous = NORMAL;");
        }

        tx_res?;
        target.sync_catalog(&self.catalog);
        Ok(())
    }
}

fn validate_batch_attrs(b: &BatchMsg, _direct_jsonb: bool) -> Result<(), String> {
    let mut scratch = Vec::new();
    for (idx, ev) in b.rows.iter().enumerate() {
        if let Some(attrs) = &ev.attrs {
            if !encode_json_str_to_jsonb_buf(attrs, &mut scratch) {
                return Err(format!("invalid JSON in event attrs at row {idx}"));
            }
        }
        if let Some(res) = &ev.resource {
            if let Some(rattrs) = &res.attrs {
                if !encode_json_str_to_jsonb_buf(rattrs, &mut scratch) {
                    return Err(format!("invalid JSON in resource attrs at row {idx}"));
                }
            }
        }
    }
    Ok(())
}

fn intern_resource(
    conn: &Connection,
    lru: &mut ResourceLru,
    res: &Resource,
) -> rusqlite::Result<i64> {
    let hash = res.canonical_hash();
    if let Some(id) = lru.get(&hash) {
        return Ok(id);
    }

    let mut ins = conn.prepare_cached(
        "INSERT INTO resources (hash, host, service, version, pid, attrs)
         VALUES (?1, ?2, ?3, ?4, ?5, jsonb(?6))
         ON CONFLICT(hash) DO NOTHING",
    )?;
    let changed = ins.execute(params![
        &hash[..],
        res.host.as_deref(),
        res.service.as_str(),
        res.version.as_deref(),
        res.pid,
        res.attrs.as_deref(),
    ])?;

    let id = if changed > 0 {
        conn.last_insert_rowid()
    } else {
        let mut sel = conn.prepare_cached("SELECT id FROM resources WHERE hash = ?1")?;
        sel.query_row(params![&hash[..]], |r| r.get(0))?
    };

    lru.insert(hash, id);
    Ok(id)
}

/// Cap a UTF-8 string at 16 KiB on a valid char boundary (engine.md §2.1).
fn cap_utf8_16k(s: &str) -> &str {
    if s.len() <= MAX_BODY_BYTES {
        return s;
    }
    let mut end = MAX_BODY_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Query the latest cursor for `source` across today's hot file, yesterday's file,
/// and `evidence.sqlite`, returning the one with the newest `updated_ingest_ts` (engine.md §3.4).
pub fn query_latest_cursor(
    catalog: &RwLock<Catalog>,
    source: &str,
) -> Result<Option<CursorUpdate>, StoreError> {
    let files: Vec<(PathBuf, bool)> = {
        let guard = catalog.read().unwrap();
        let mut v: Vec<(PathBuf, bool)> = guard
            .days
            .values()
            .rev()
            .take(2)
            .map(|e| (e.path.clone(), false))
            .collect();
        if let Some(ev) = &guard.evidence {
            v.push((ev.path.clone(), true));
        }
        v
    };

    let mut best: Option<CursorUpdate> = None;
    for (path, is_ev) in files {
        if !path.exists() {
            continue;
        }
        let Ok(conn) = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let _ = conn.busy_timeout(Duration::from_millis(1000));
        let row: Option<CursorUpdate> = conn
            .query_row(
                "SELECT source, dev, ino, head_hash, offset, updated_ingest_ts
                 FROM cursors WHERE source = ?1",
                params![source],
                |r| {
                    Ok(CursorUpdate {
                        source: r.get(0)?,
                        dev: r.get(1)?,
                        ino: r.get(2)?,
                        head_hash: r.get(3)?,
                        offset: r.get(4)?,
                        updated_ingest_ts: r.get(5)?,
                        is_evidence: is_ev,
                    })
                },
            )
            .optional()?;
        if let Some(cur) = row {
            if best
                .as_ref()
                .is_none_or(|b| cur.updated_ingest_ts > b.updated_ingest_ts)
            {
                best = Some(cur);
            }
        }
    }
    Ok(best)
}

/// Expire rows older than 180 days from `evidence.sqlite` in batches of 1,000,
/// followed by `PRAGMA incremental_vacuum` (engine.md §2.7).
pub fn expire_evidence_rows(root: &Path, now_ns: i64) -> Result<usize, StoreError> {
    let evidence_path = root.join("evidence.sqlite");
    if !evidence_path.exists() {
        return Ok(0);
    }
    let cutoff_ns = now_ns.saturating_sub(180 * crate::catalog::NS_PER_DAY);
    let conn = Connection::open(&evidence_path)?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    let mut total_deleted = 0usize;
    loop {
        let deleted = conn.execute(
            "DELETE FROM events WHERE id IN (
                SELECT id FROM events WHERE ingest_ts < ?1 LIMIT 1000
             )",
            params![cutoff_ns],
        )?;
        total_deleted += deleted;
        if deleted < 1000 {
            break;
        }
    }
    if total_deleted > 0 {
        let _ = conn.execute_batch(
            "PRAGMA incremental_vacuum;
             PRAGMA wal_checkpoint(TRUNCATE);",
        );
    } else {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
    }
    Ok(total_deleted)
}

/// Injectable clock for testing UTC midnight rolls and staleness.
#[derive(Debug)]
pub struct ManualClock {
    now_ns: AtomicI64,
}

impl ManualClock {
    pub fn new(initial_ns: i64) -> Self {
        Self {
            now_ns: AtomicI64::new(initial_ns),
        }
    }

    pub fn set_ns(&self, ns: i64) {
        self.now_ns.store(ns, Ordering::SeqCst);
    }

    pub fn advance_ns(&self, delta_ns: i64) -> i64 {
        self.now_ns.fetch_add(delta_ns, Ordering::SeqCst) + delta_ns
    }
}

impl Clock for ManualClock {
    fn now_ns(&self) -> i64 {
        self.now_ns.load(Ordering::SeqCst)
    }
}
