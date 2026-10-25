use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::task::{Context as TaskContext, Poll, Waker};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TryRecvError};
use rusqlite::{params, Connection, OptionalExtension};

use crate::catalog::{utc_day_string, Catalog, CatalogEntry, DayFileState};
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

#[derive(Clone)]
pub(crate) struct AckSender {
    shared: Arc<AckShared>,
}

impl AckSender {
    fn send(self, res: Result<CommitAck, StoreError>) {
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

/// Handle returned by [`Writer::submit`] that resolves only after the batch's transaction commits
/// (engine.md §3.3). Can be awaited as a `Future` or blocked on synchronously via [`Ack::wait`].
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

struct BatchMsg {
    rows: Vec<Event>,
    cursors: Vec<CursorUpdate>,
    bytes: usize,
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
    fn spawn(hot_path: PathBuf, metrics: Arc<WriterMetrics>) -> Result<Self, StoreError> {
        let (tx, rx) = crossbeam_channel::unbounded::<CheckpointerCmd>();
        let tx_lock = Arc::new(Mutex::new(()));
        let bytes_since_reset = Arc::new(AtomicU64::new(0));
        let lock_clone = Arc::clone(&tx_lock);
        let bytes_clone = Arc::clone(&bytes_since_reset);
        let join = thread::Builder::new()
            .name("motel-ckpt".to_owned())
            .spawn(move || checkpointer_loop(hot_path, rx, metrics, lock_clone, bytes_clone))
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

    fn stop(mut self) {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let _ = self.tx.send(CheckpointerCmd::Stop(tx));
        let _ = rx.recv_timeout(Duration::from_secs(5));
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn checkpointer_loop(
    hot_path: PathBuf,
    rx: Receiver<CheckpointerCmd>,
    metrics: Arc<WriterMetrics>,
    tx_lock: Arc<Mutex<()>>,
    bytes_since_reset: Arc<AtomicU64>,
) {
    const WAL_PASSIVE_THRESHOLD: u64 = 4 * 1024 * 1024; // 4 MiB (§3.2)
    const WAL_LIMIT_THRESHOLD: u64 = 16 * 1024 * 1024; // 16 MiB journal_size_limit (§2.2)

    let mut conn: Option<Connection> = None;
    let mut last_passive = Instant::now()
        .checked_sub(Duration::from_secs(10))
        .unwrap_or_else(Instant::now);

    // Block on rx.recv() when idle — no timer runs at idle (engine.md §3.2).
    while let Ok(cmd) = rx.recv() {
        match cmd {
            CheckpointerCmd::NotifyWalSize(mut wal_bytes) => {
                // Drain any queued notifications to use the freshest WAL size.
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
                    continue;
                }
                let is_over_limit = active_bytes >= WAL_LIMIT_THRESHOLD;
                if !is_over_limit && last_passive.elapsed() < Duration::from_secs(1) {
                    continue;
                }

                if conn.is_none() {
                    if let Ok(c) = Connection::open(&hot_path) {
                        if configure_checkpointer_conn(&c).is_ok() {
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
                    if let Ok((_, log_frames, _)) = passive_res {
                        let actual_wal_bytes = (log_frames.max(0) as u64) * 4120;
                        if actual_wal_bytes >= WAL_LIMIT_THRESHOLD {
                            // PASSIVE copied all committed frames up to the writer's in-flight batch.
                            // Now acquire tx_lock between writer transactions and run RESTART so the
                            // final batch is checkpointed and the next writer transaction rewinds to frame 1.
                            let _guard = tx_lock.lock().unwrap();
                            let _ = c.execute_batch("PRAGMA wal_checkpoint(RESTART);");
                            bytes_since_reset.store(0, Ordering::Relaxed);
                        } else if actual_wal_bytes < WAL_PASSIVE_THRESHOLD {
                            bytes_since_reset.store(actual_wal_bytes, Ordering::Relaxed);
                        }
                    }
                    let cpu_delta = current_thread_cpu_ns().saturating_sub(cpu0);
                    metrics
                        .checkpoint_cpu_ns
                        .fetch_add(cpu_delta, Ordering::Relaxed);
                    last_passive = Instant::now();
                }
            }
            CheckpointerCmd::Stop(ack) => {
                drop(conn);
                let _ = ack.send(());
                return;
            }
        }
    }
}

/// Handle to submit normalized events and cursor updates to the single writer thread (engine.md §3.1, §3.2).
#[derive(Clone)]
pub struct Writer {
    tx: Sender<WriterCmd>,
    queue_byte_budget: usize,
    metrics: Arc<WriterMetrics>,
    space_lock: Arc<(Mutex<()>, Condvar)>,
}

impl Writer {
    /// Submit a batch of normalized events. Reserves bytes from the 4 MiB queue budget first;
    /// returns [`SubmitError::QueueFull`] (HTTP 429 + `Retry-After: 1`) if full (engine.md §3.1).
    pub fn submit(&self, rows: Vec<Event>) -> Result<Ack, SubmitError> {
        self.submit_with_cursors(rows, Vec::new())
    }

    /// Submit a batch of normalized events along with tailer cursor updates to be committed
    /// in the same transaction (engine.md §3.2, §3.4).
    pub fn submit_with_cursors(
        &self,
        rows: Vec<Event>,
        cursors: Vec<CursorUpdate>,
    ) -> Result<Ack, SubmitError> {
        let bytes = estimate_batch_bytes(&rows, &cursors);
        self.reserve_bytes(bytes)?;
        let (ack_tx, ack_rx) = Ack::pair();
        let msg = BatchMsg {
            rows,
            cursors,
            bytes,
            enqueued_at: Instant::now(),
            ack_tx,
        };
        if self.tx.send(WriterCmd::Batch(msg)).is_err() {
            self.release_bytes(bytes);
            return Err(SubmitError::Closed);
        }
        Ok(ack_rx)
    }

    /// Blocking submit for file tailers, which wait instead of failing with 429 (engine.md §3.1).
    pub fn submit_blocking(
        &self,
        rows: Vec<Event>,
        cursors: Vec<CursorUpdate>,
    ) -> Result<Ack, SubmitError> {
        let bytes = estimate_batch_bytes(&rows, &cursors);
        loop {
            match self.reserve_bytes(bytes) {
                Ok(()) => break,
                Err(SubmitError::QueueFull { .. }) => {
                    let (lock, cvar) = &*self.space_lock;
                    let guard = lock.lock().unwrap();
                    let _ = cvar.wait_timeout(guard, Duration::from_millis(10)).unwrap();
                }
                Err(e) => return Err(e),
            }
        }
        let (ack_tx, ack_rx) = Ack::pair();
        let msg = BatchMsg {
            rows,
            cursors,
            bytes,
            enqueued_at: Instant::now(),
            ack_tx,
        };
        if self.tx.send(WriterCmd::Batch(msg)).is_err() {
            self.release_bytes(bytes);
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

    fn reserve_bytes(&self, bytes: usize) -> Result<(), SubmitError> {
        let mut cur = self.metrics.queued_bytes.load(Ordering::Relaxed);
        loop {
            // Allow a single batch even if cur == 0 and bytes <= queue_byte_budget;
            // reject if cur + bytes > queue_byte_budget.
            if cur.saturating_add(bytes) > self.queue_byte_budget {
                self.metrics
                    .rejected_429_count
                    .fetch_add(1, Ordering::Relaxed);
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
                    return Ok(());
                }
                Err(actual) => cur = actual,
            }
        }
    }

    fn release_bytes(&self, bytes: usize) {
        self.metrics.queued_bytes.fetch_sub(bytes, Ordering::Release);
        let (_, cvar) = &*self.space_lock;
        cvar.notify_all();
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
    join: Option<JoinHandle<()>>,
}

impl WriterControl {
    pub fn spawn(
        config: StoreConfig,
        clock: Arc<dyn Clock>,
        catalog: Arc<RwLock<Catalog>>,
        reader_pool: Arc<ReaderPool>,
    ) -> Result<Self, StoreError> {
        let (tx, rx) = crossbeam_channel::unbounded::<WriterCmd>();
        let metrics = Arc::new(WriterMetrics::default());
        let space_lock = Arc::new((Mutex::new(()), Condvar::new()));

        let state = WriterThreadState::new(
            config.clone(),
            clock,
            catalog,
            reader_pool,
            Arc::clone(&metrics),
            Arc::clone(&space_lock),
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
            join: Some(join),
        })
    }

    pub fn handle(&self) -> Writer {
        self.writer.clone()
    }

    pub fn shutdown(&mut self) {
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
    space_lock: Arc<(Mutex<()>, Condvar)>,
    hot: OpenTargetFile,
    checkpointer: CheckpointerHandle,
    evidence: OpenTargetFile,
    last_durable_instant: Instant,
    dirty_since_durable: bool,
    seal_handles: Vec<JoinHandle<()>>,
}

impl WriterThreadState {
    fn new(
        config: StoreConfig,
        clock: Arc<dyn Clock>,
        catalog: Arc<RwLock<Catalog>>,
        reader_pool: Arc<ReaderPool>,
        metrics: Arc<WriterMetrics>,
        space_lock: Arc<(Mutex<()>, Condvar)>,
    ) -> Result<Self, StoreError> {
        let today = utc_day_string(clock.now_ns());
        let hot = OpenTargetFile::open_hot_day(&config.root_dir, &today, &config, &catalog)?;
        let checkpointer = CheckpointerHandle::spawn(hot.path.clone(), Arc::clone(&metrics))?;
        let evidence = OpenTargetFile::open_evidence(&config.root_dir, &config, &catalog)?;

        Ok(Self {
            config,
            clock,
            catalog,
            reader_pool,
            metrics,
            space_lock,
            hot,
            checkpointer,
            evidence,
            last_durable_instant: Instant::now(),
            dirty_since_durable: false,
            seal_handles: Vec::new(),
        })
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
            let mut shutdown_waiter: Option<Sender<()>> = None;

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
                        shutdown_waiter = Some(tx);
                        break;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        shutdown_waiter = Some(crossbeam_channel::bounded(1).0);
                        break;
                    }
                }
            }

            // 2. Decide whether to commit now.
            let commit_now = !pending.is_empty()
                && (pending_rows >= self.config.group_commit_max_rows
                    || pending_bytes >= self.config.group_commit_max_bytes
                    || !flush_waiters.is_empty()
                    || !seal_waiters.is_empty()
                    || shutdown_waiter.is_some()
                    || oldest_enqueue
                        .is_some_and(|t| t.elapsed() >= self.config.group_commit_interval));

            if commit_now {
                let res = self.commit_group(&mut pending);
                pending_rows = 0;
                pending_bytes = 0;
                oldest_enqueue = None;
                for tx in flush_waiters.drain(..) {
                    let _ = tx.send(res.as_ref().copied().map_err(|e| StoreError::Other(e.to_string())));
                }
            } else if !flush_waiters.is_empty() {
                // Even if pending was empty, check if day rolled or Mode T dirty needs flush.
                let res = self.maybe_roll_day_and_heartbeat(true);
                for tx in flush_waiters.drain(..) {
                    let _ = tx.send(res.as_ref().copied().map_err(|e| StoreError::Other(e.to_string())));
                }
            }

            if !seal_waiters.is_empty() {
                let _ = self.maybe_roll_day_and_heartbeat(false);
                self.join_seals();
                for tx in seal_waiters.drain(..) {
                    let _ = tx.send(());
                }
            }

            if let Some(tx) = shutdown_waiter {
                if !pending.is_empty() {
                    let _ = self.commit_group(&mut pending);
                }
                let _ = self.maybe_roll_day_and_heartbeat(true);
                self.join_seals();
                self.checkpointer.stop();
                let _ = tx.send(());
                return;
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
                            pending_rows = 0;
                            pending_bytes = 0;
                            oldest_enqueue = None;
                        }
                        let _ = self.maybe_roll_day_and_heartbeat(false);
                        self.join_seals();
                        let _ = tx.send(());
                    }
                    Ok(WriterCmd::Shutdown(tx)) => {
                        if !pending.is_empty() {
                            let _ = self.commit_group(&mut pending);
                        }
                        let _ = self.maybe_roll_day_and_heartbeat(true);
                        self.join_seals();
                        self.checkpointer.stop();
                        let _ = tx.send(());
                        return;
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            if matches!(self.config.durability_mode, DurabilityMode::ModeT)
                                && self.dirty_since_durable
                                && self.last_durable_instant.elapsed() >= Duration::from_secs(1)
                            {
                                let _ = self.run_durable_heartbeat();
                            } else if !shrunk_since_idle
                                && last_activity.elapsed() >= Duration::from_secs(30)
                            {
                                // Shrink writer page cache after 30 s idle (engine.md §5).
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
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            let _ = self.commit_group(&mut pending);
                        }
                        self.join_seals();
                        self.checkpointer.stop();
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
                        let _ = self.maybe_roll_day_and_heartbeat(true);
                        self.join_seals();
                        self.checkpointer.stop();
                        let _ = tx.send(());
                        return;
                    }
                    Err(_) => {
                        self.join_seals();
                        self.checkpointer.stop();
                        return;
                    }
                },
            }
        }
    }

    fn join_seals(&mut self) {
        for h in self.seal_handles.drain(..) {
            let _ = h.join();
        }
    }

    fn maybe_roll_day_and_heartbeat(&mut self, force_durable: bool) -> Result<(), StoreError> {
        let now_ns = self.clock.now_ns();
        let arrival_day = utc_day_string(now_ns);
        if arrival_day != self.hot.day {
            self.roll_day(&arrival_day, now_ns)?;
        }
        if force_durable && self.dirty_since_durable {
            self.run_durable_heartbeat()?;
        }
        Ok(())
    }

    fn roll_day(&mut self, new_day: &str, now_ns: i64) -> Result<(), StoreError> {
        // Ensure any dirty WAL on the old day is durable before sealing.
        if self.dirty_since_durable {
            let _ = self.run_durable_heartbeat();
        }

        let old_day = self.hot.day.clone();
        // Replace checkpointer and hot connection with the new day first.
        let new_hot =
            OpenTargetFile::open_hot_day(&self.config.root_dir, new_day, &self.config, &self.catalog)?;
        let new_ckpt = CheckpointerHandle::spawn(new_hot.path.clone(), Arc::clone(&self.metrics))?;

        let old_hot = std::mem::replace(&mut self.hot, new_hot);
        let old_ckpt = std::mem::replace(&mut self.checkpointer, new_ckpt);
        old_ckpt.stop();
        drop(old_hot);

        // Spawn background-QoS sealer for old_day (engine.md §2.5).
        let root_dir = self.config.root_dir.clone();
        let catalog = Arc::clone(&self.catalog);
        let reader_pool = Arc::clone(&self.reader_pool);
        let stop_after_step = self.config.seal_stop_after_step;
        let handle = thread::Builder::new()
            .name(format!("motel-seal-{old_day}"))
            .spawn(move || {
                set_background_qos();
                let _ = seal_day_file(
                    &root_dir,
                    &old_day,
                    now_ns,
                    &catalog,
                    Some(&reader_pool),
                    stop_after_step,
                );
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

    fn commit_group(&mut self, batches: &mut Vec<BatchMsg>) -> Result<(), StoreError> {
        let now_ns = self.clock.now_ns();
        let arrival_day = utc_day_string(now_ns);
        if arrival_day != self.hot.day {
            self.roll_day(&arrival_day, now_ns)?;
        }

        // Partition events and cursors between today's hot day file and evidence.sqlite (§2.7).
        let mut hot_rows: Vec<&Event> = Vec::new();
        let mut ev_rows: Vec<&Event> = Vec::new();
        let mut hot_cursors: Vec<&CursorUpdate> = Vec::new();
        let mut ev_cursors: Vec<&CursorUpdate> = Vec::new();
        let mut total_bytes = 0usize;

        for b in batches.iter() {
            total_bytes += b.bytes;
            for r in &b.rows {
                if r.is_evidence() {
                    ev_rows.push(r);
                } else {
                    hot_rows.push(r);
                }
            }
            for c in &b.cursors {
                if c.is_evidence {
                    ev_cursors.push(c);
                } else {
                    hot_cursors.push(c);
                }
            }
        }

        let cpu0 = current_thread_cpu_ns();
        let mut commit_result: Result<(), StoreError> = Ok(());

        if !hot_rows.is_empty() || !hot_cursors.is_empty() {
            let run_full_sync = match self.config.durability_mode {
                DurabilityMode::ModeF => true,
                DurabilityMode::ModeT => {
                    self.last_durable_instant.elapsed() >= Duration::from_secs(1)
                }
            };

            {
                let tx_lock = Arc::clone(&self.checkpointer.tx_lock);
                let _tx_guard = tx_lock.lock().unwrap();
                commit_result = self.commit_to_target(
                    false,
                    &hot_rows,
                    &hot_cursors,
                    now_ns,
                    run_full_sync,
                );
            }

            if commit_result.is_ok() {
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
                self.checkpointer.record_commit_bytes(total_bytes as u64);
            }
        }

        if commit_result.is_ok() && (!ev_rows.is_empty() || !ev_cursors.is_empty()) {
            commit_result = self.commit_to_target(true, &ev_rows, &ev_cursors, now_ns, true);
        }

        let cpu_delta = current_thread_cpu_ns().saturating_sub(cpu0);
        self.metrics
            .writer_insert_cpu_ns
            .fetch_add(cpu_delta, Ordering::Relaxed);

        let total_rows = (hot_rows.len() + ev_rows.len()) as u64;
        let batch_count = batches.len() as u64;
        if commit_result.is_ok() {
            self.metrics
                .committed_rows
                .fetch_add(total_rows, Ordering::Relaxed);
            self.metrics
                .committed_batches
                .fetch_add(batch_count, Ordering::Relaxed);
            self.metrics.committed_txns.fetch_add(1, Ordering::Relaxed);
        }

        // Release reserved queue bytes before waking callers.
        self.metrics
            .queued_bytes
            .fetch_sub(total_bytes, Ordering::Release);
        {
            let (_, cvar) = &*self.space_lock;
            cvar.notify_all();
        }

        // Acknowledge every batch immediately after commit (engine.md §3.3).
        let day_name = self.hot.day.clone();
        for b in batches.drain(..) {
            let n = b.rows.len();
            match &commit_result {
                Ok(()) => {
                    b.ack_tx.send(Ok(CommitAck {
                        day: day_name.clone(),
                        rows_committed: n,
                        ingest_ts: now_ns,
                    }));
                }
                Err(e) => {
                    b.ack_tx
                        .send(Err(StoreError::Other(format!("commit failed: {e}"))));
                }
            }
        }

        commit_result
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
                    if err.code == rusqlite::ErrorCode::OutOfMemory && attempt == 1 =>
                {
                    // On SQLITE_NOMEM the writer closes every reader and retries the batch once (§2.2).
                    self.metrics.nomem_retries.fetch_add(1, Ordering::Relaxed);
                    self.reader_pool.close_all();
                    let _ = self.hot.conn.release_memory();
                    let _ = self.evidence.conn.release_memory();
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
            let mut batch_min_ingest = target.min_ingest_ts.unwrap_or(i64::MAX);
            let mut batch_max_ingest = target.max_ingest_ts.unwrap_or(i64::MIN);

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
                    let ingest_ts = ev.ingest_ts.unwrap_or(now_ns);
                    batch_min_ts = batch_min_ts.min(ev.ts);
                    batch_max_ts = batch_max_ts.max(ev.ts);
                    batch_min_ingest = batch_min_ingest.min(ingest_ts);
                    batch_max_ingest = batch_max_ingest.max(ingest_ts);

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
                        let has_jsonb = ev
                            .attrs
                            .as_deref()
                            .is_some_and(|s| encode_json_str_to_jsonb_buf(s, &mut jsonb_buf));
                        let jsonb_slice: Option<&[u8]> = if has_jsonb {
                            Some(jsonb_buf.as_slice())
                        } else {
                            None
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
                    cur_stmt.execute(params![
                        c.source.as_str(),
                        c.dev,
                        c.ino,
                        c.head_hash.as_deref(),
                        c.offset,
                        c.updated_ingest_ts,
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
        let _ = conn.execute_batch("PRAGMA incremental_vacuum;");
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
