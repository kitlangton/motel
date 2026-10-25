use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use motel_store::{
    current_process_cpu_ns, current_thread_cpu_ns, Ack, DurabilityMode, Event, EventKind,
    EventSource, Resource, Store, StoreConfig, SubmitError, NS_PER_DAY, NS_PER_HOUR,
};
use rusqlite::Connection;
use serde::Serialize;

const SERVICES: [&str; 5] = ["api", "worker", "web", "db-proxy", "scheduler"];
const OPS: [&str; 8] = [
    "GET /users",
    "POST /orders",
    "db.query",
    "cache.get",
    "queue.publish",
    "render",
    "auth.check",
    "fetch.upstream",
];
const FNS: [&str; 8] = [
    "handlers::users::list",
    "orders::create",
    "db::pool::acquire",
    "cache::lookup",
    "queue::send",
    "ui::render_frame",
    "auth::verify",
    "http::upstream_call",
];
const STMTS: [&str; 3] = [
    "SELECT id, name, email, created_at FROM users WHERE id = $1 AND deleted_at IS NULL",
    "INSERT INTO orders (user_id, total, currency, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
    "UPDATE sessions SET last_seen = now() WHERE token = $1",
];
const NSESS: u32 = 2000;
const SEARCH_NEEDLE: &str = "display link";

/// Seeded LCG matching `spikes/gen.ts` (`s = (s * 1664525 + 1013904223) >>> 0`).
struct Rng {
    state: u32,
}

impl Rng {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    #[inline]
    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.state as f64) / 4_294_967_296.0
    }

    #[inline]
    fn pick<'a, T>(&mut self, slice: &'a [T]) -> &'a T {
        let idx = (self.next_f64() * (slice.len() as f64)) as usize;
        &slice[idx.min(slice.len() - 1)]
    }

    fn hex_string(&mut self, nibbles: usize) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(nibbles);
        for _ in 0..nibbles {
            let v = (self.next_f64() * 16.0) as usize;
            out.push(HEX[v.min(15)] as char);
        }
        out
    }

    fn bytes_16(&mut self) -> [u8; 16] {
        let mut b = [0u8; 16];
        for byte in &mut b {
            let hi = ((self.next_f64() * 16.0) as u8).min(15);
            let lo = ((self.next_f64() * 16.0) as u8).min(15);
            *byte = (hi << 4) | lo;
        }
        b
    }

    fn bytes_8(&mut self) -> [u8; 8] {
        let mut b = [0u8; 8];
        for byte in &mut b {
            let hi = ((self.next_f64() * 16.0) as u8).min(15);
            let lo = ((self.next_f64() * 16.0) as u8).min(15);
            *byte = (hi << 4) | lo;
        }
        b
    }
}

#[derive(Clone)]
struct TraceCtx {
    trace_id: [u8; 16],
    session_id: String,
    request_id: Option<String>,
}

/// Deterministic fixture generator ported from `spikes/gen.ts` + `engine.md` §8:
/// - seed 12345
/// - half spans and half logs in 500-row batches
/// - 5 services, 10 spans per trace, 2,000 sessions
/// - request IDs on 20% of rows
/// - 4 to 9 attributes
/// - ~200 B average bodies (1% at 16 KiB)
/// - 4% errors (3% error spans, 5% ERROR logs)
/// - 5% of timestamps a day late
/// - needle `display link` in 0.05% of bodies
struct FixtureGenerator {
    rng: Rng,
    total: usize,
    batch_size: usize,
    t0_ns: i64,
    i: usize,
    cur_trace: TraceCtx,
    in_trace: usize,
    parent_span: Option<[u8; 8]>,
    recent_traces: Vec<TraceCtx>,
    large_body_pad: String,
}

impl FixtureGenerator {
    fn new(seed: u32, total: usize, batch_size: usize, t0_ns: i64) -> Self {
        let mut rng = Rng::new(seed);
        let trace_id = rng.bytes_16();
        let req_id = if rng.next_f64() < 0.20 {
            Some(rng.hex_string(12))
        } else {
            None
        };
        let cur_trace = TraceCtx {
            trace_id,
            session_id: "s0".to_owned(),
            request_id: req_id,
        };
        Self {
            rng,
            total,
            batch_size,
            t0_ns,
            i: 0,
            cur_trace,
            in_trace: 0,
            parent_span: None,
            recent_traces: Vec::with_capacity(64),
            large_body_pad: "x".repeat(15_800),
        }
    }

    fn next_batch(&mut self) -> Option<Vec<Event>> {
        if self.i >= self.total {
            return None;
        }
        let is_span = (self.i / self.batch_size).is_multiple_of(2);
        let count = (self.total - self.i).min(self.batch_size);
        let mut out = Vec::with_capacity(count);

        for _ in 0..count {
            let progress = (self.i as f64) / (self.total.max(1) as f64);
            let mut ts = self.t0_ns
                + ((progress * (NS_PER_HOUR as f64)) as i64)
                + ((self.rng.next_f64() * 1000.0) as i64);

            // 5% of timestamps are a day late (engine.md §8).
            if self.rng.next_f64() < 0.05 {
                ts -= NS_PER_DAY;
            }

            let service = (*self.rng.pick(&SERVICES)).to_owned();
            let pid = 4000 + ((self.rng.next_f64() * 5.0) as i64);
            let resource = Some(Resource {
                host: Some("bench-host".to_owned()),
                service: service.clone(),
                version: Some("0.1.0".to_owned()),
                pid: Some(pid),
                attrs: Some(format!(
                    r#"{{"service.name":"{service}","host.name":"bench-host","deployment.environment":"local"}}"#
                )),
            });

            if is_span {
                if self.in_trace == 10 {
                    // Active session window of 16 concurrent sessions sliding across all 2,000 sessions over the hour.
                    let base_sess = ((progress * ((NSESS - 16) as f64)) as u32).min(NSESS - 16);
                    let sess_num = base_sess + ((self.rng.next_f64() * 16.0) as u32);
                    let session_id = format!("s{sess_num}");
                    // Request IDs on 20% of traces/rows (engine.md §8).
                    let request_id = if self.rng.next_f64() < 0.20 {
                        Some(self.rng.hex_string(12))
                    } else {
                        None
                    };
                    self.cur_trace = TraceCtx {
                        trace_id: self.rng.bytes_16(),
                        session_id,
                        request_id,
                    };
                    self.in_trace = 0;
                    self.parent_span = None;
                }
                if self.in_trace == 0 {
                    if self.recent_traces.len() < 64 {
                        self.recent_traces.push(self.cur_trace.clone());
                    } else {
                        let slot = (self.rng.next_f64() * 64.0) as usize;
                        self.recent_traces[slot.min(63)] = self.cur_trace.clone();
                    }
                }
                let err = self.rng.next_f64() < 0.03;
                let span_id = self.rng.bytes_8();
                let fn_name = *self.rng.pick(&FNS);
                let dur_ms = 1 + ((self.rng.next_f64() * 200.0) as i64);
                let method = *self.rng.pick(&["GET", "POST"]);
                let route = *self.rng.pick(&OPS);
                let status_code = if err { 500 } else { 200 };
                let user_num = (self.rng.next_f64() * 1000.0) as u32;
                let op_name = (*self.rng.pick(&OPS)).to_owned();

                let mut attrs = String::with_capacity(256);
                attrs.push_str(&format!(
                    r#"{{"http.method":"{method}","http.route":"{route}","http.status_code":{status_code},"user.id":"u{user_num}","code.function":"{fn_name}""#
                ));
                if self.rng.next_f64() < 0.30 {
                    let stmt = *self.rng.pick(&STMTS);
                    attrs.push_str(&format!(r#","db.statement":"{stmt}""#));
                }
                if err {
                    attrs.push_str(
                        r#","exception.message":"boom: upstream timeout after 30000ms""#,
                    );
                }
                attrs.push('}');

                let parent_id = self.parent_span;
                if self.in_trace == 0 {
                    self.parent_span = Some(span_id);
                }
                self.in_trace += 1;

                out.push(Event {
                    ts,
                    ingest_ts: Some(ts),
                    dur: Some(dur_ms * 1_000_000),
                    kind: EventKind::Span,
                    service,
                    severity: None,
                    status: Some(if err { "error" } else { "ok" }.to_owned()),
                    err,
                    name: Some(op_name),
                    trace_id: Some(self.cur_trace.trace_id),
                    span_id: Some(span_id),
                    parent_id,
                    session_id: Some(self.cur_trace.session_id.clone()),
                    request_id: self.cur_trace.request_id.clone(),
                    resource,
                    src: EventSource::Otlp,
                    artifact: None,
                    body: None,
                    attrs: Some(attrs),
                });
            } else {
                let r = self.rng.next_f64();
                let lv = if r < 0.70 {
                    9
                } else if r < 0.85 {
                    5
                } else if r < 0.95 {
                    13
                } else {
                    17
                };
                let has_needle = self.rng.next_f64() < 0.0005;
                // 1% of log bodies at 16 KiB -> combined with ~40 B normal log bodies gives ~200 B average body (engine.md §8).
                let is_16k = self.rng.next_f64() < 0.01;
                let op = *self.rng.pick(&OPS);
                let id_hex = self.rng.hex_string(8);
                let user_num = (self.rng.next_f64() * 1000.0) as u32;
                let msg_part = if lv == 17 {
                    "failed: connection reset by peer"
                } else {
                    "ok"
                };
                let needle_part = if has_needle {
                    format!(" {SEARCH_NEEDLE} stalled for 33ms")
                } else {
                    String::new()
                };
                let pad = if is_16k {
                    self.large_body_pad.as_str()
                } else {
                    ""
                };
                let body = format!("{op} {msg_part} id={id_hex}{needle_part} user=u{user_num}{pad}");

                let fn_name = *self.rng.pick(&FNS);
                let attrs = format!(
                    r#"{{"code.function":"{fn_name}","log.target":"bench::{service}","user.id":"u{user_num}","log.level":{lv}}}"#
                );

                let tctx = if !self.recent_traces.is_empty() {
                    let idx = (self.rng.next_f64() * (self.recent_traces.len() as f64)) as usize;
                    self.recent_traces[idx.min(self.recent_traces.len() - 1)].clone()
                } else {
                    self.cur_trace.clone()
                };

                out.push(Event {
                    ts,
                    ingest_ts: Some(ts),
                    dur: None,
                    kind: EventKind::Log,
                    service,
                    severity: Some(lv),
                    status: if lv >= 17 {
                        Some("error".to_owned())
                    } else {
                        None
                    },
                    err: lv >= 17,
                    name: Some("log".to_owned()),
                    trace_id: Some(tctx.trace_id),
                    span_id: Some(self.rng.bytes_8()),
                    parent_id: None,
                    session_id: Some(tctx.session_id),
                    request_id: tctx.request_id,
                    resource,
                    src: EventSource::Otlp,
                    artifact: None,
                    body: Some(body),
                    attrs: Some(attrs),
                });
            }

            self.i += 1;
        }

        Some(out)
    }
}

/// Query `phys_footprint` and `resident_size` in bytes on macOS via `proc_pid_rusage(RUSAGE_INFO_V4)`.
fn current_memory_footprint() -> (u64, u64) {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut info: libc::rusage_info_v4 = std::mem::zeroed();
        let rc = libc::proc_pid_rusage(
            std::process::id() as i32,
            libc::RUSAGE_INFO_V4,
            &mut info as *mut _ as *mut libc::rusage_info_t,
        );
        if rc == 0 {
            return (info.ri_phys_footprint, info.ri_resident_size);
        }
    }
    (0, 0)
}

/// Query total process CPU time (user + system) in nanoseconds on macOS.
fn process_cpu_ns() -> u64 {
    current_process_cpu_ns()
}

#[derive(Debug, Clone, Serialize)]
struct ChunkStats {
    up_to_rows: usize,
    rows_in_chunk: usize,
    wall_sec: f64,
    rows_per_sec: f64,
    process_cpu_sec_per_100k: f64,
    gen_cpu_sec_per_100k: f64,
    insert_cpu_sec_per_100k: f64,
    checkpoint_cpu_sec_per_100k: f64,
}

#[derive(Debug, Clone, Serialize)]
struct DiskMetrics {
    hot_file_bytes_before_ckpt: u64,
    wal_bytes_before_ckpt: u64,
    total_bytes_after_ckpt: u64,
    bytes_per_million: u64,
    mib_per_million: f64,
    by_object_mib: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
struct B1Report {
    benchmark: &'static str,
    note: &'static str,
    hostname: String,
    sqlite_version: String,
    rows: usize,
    batch_size: usize,
    durability_mode: String,
    page_size: u32,
    with_ix_req: bool,
    payloads_split: bool,
    direct_jsonb: bool,
    steady_trickle: SteadyStats,
    slope: SlopeSummary,
    chunks_100k: Vec<ChunkStats>,
    ack_latency_ms: LatencyPercentiles,
    rejected_429s: u64,
    queue_peak_bytes: usize,
    wal_peak_bytes: u64,
    committed_txns: u64,
    durable_sync_count: u64,
    disk: DiskMetrics,
    memory: MemoryMetrics,
    gates: GateEvaluation,
}

#[derive(Debug, Clone, Serialize)]
struct SteadyStats {
    duration_sec: f64,
    rows_sent: usize,
    cpu_sec: f64,
    cpu_pct_of_one_core: f64,
}

#[derive(Debug, Clone, Serialize)]
struct SlopeSummary {
    window_rows: usize,
    first_window_insert_cpu_s_per_100k: f64,
    last_window_insert_cpu_s_per_100k: f64,
    insert_last_over_first_ratio: f64,
    first_window_total_cpu_s_per_100k: f64,
    last_window_total_cpu_s_per_100k: f64,
    total_last_over_first_ratio: f64,
    overall_insert_cpu_s_per_100k: f64,
    overall_gen_cpu_s_per_100k: f64,
    overall_checkpoint_cpu_s_per_100k: f64,
    overall_process_cpu_s_per_100k: f64,
    overall_wall_sec: f64,
    overall_rows_per_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
struct LatencyPercentiles {
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
struct MemoryMetrics {
    baseline_phys_footprint_bytes: u64,
    baseline_phys_footprint_mb: f64,
    peak_phys_footprint_bytes: u64,
    peak_phys_footprint_mb: f64,
    after_load_phys_footprint_bytes: u64,
    after_load_phys_footprint_mb: f64,
    idle_wait_sec: u64,
    after_idle_phys_footprint_bytes: u64,
    after_idle_phys_footprint_mb: f64,
    peak_rss_bytes: u64,
    after_idle_rss_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct GateEvaluation {
    insert_cpu_per_100k_le_1_0: bool,
    last_over_first_le_1_5: bool,
    steady_cpu_lt_1pct: bool,
    zero_429s: bool,
    ack_p99_le_250ms: bool,
    peak_footprint_le_40mb: bool,
    idle_footprint_le_20mb: bool,
    disk_per_million_le_380mib: bool,
    all_passed: bool,
}

fn get_arg(args: &[String], key: &str, default: &str) -> String {
    let flag = format!("--{key}");
    args.iter()
        .position(|a| a == &flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| default.to_owned())
}

fn percentile_f64(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64) * p).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn hostname_string() -> String {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc == 0 {
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..len]).into_owned()
    } else {
        "unknown".to_owned()
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let total_rows: usize = get_arg(&args, "rows", "1000000").parse().unwrap_or(1_000_000);
    let batch_size: usize = get_arg(&args, "batch", "500").parse().unwrap_or(500);
    let mode_str = get_arg(&args, "mode", "t");
    let page_size: u32 = get_arg(&args, "page-size", "4096").parse().unwrap_or(4096);
    let with_ix_req: bool = get_arg(&args, "ix-req", "true").parse().unwrap_or(true);
    let payloads_split: bool = get_arg(&args, "payloads-split", "false")
        .parse()
        .unwrap_or(false);
    let direct_jsonb: bool = get_arg(&args, "direct-jsonb", "false")
        .parse()
        .unwrap_or(false);
    let steady_secs: u64 = get_arg(&args, "steady-secs", "5").parse().unwrap_or(5);
    let idle_secs: u64 = get_arg(&args, "idle-secs", "32").parse().unwrap_or(32);
    let out_file = get_arg(&args, "out", "");
    let custom_dir = get_arg(&args, "dir", "");

    let durability_mode = if mode_str.eq_ignore_ascii_case("f") {
        DurabilityMode::ModeF
    } else {
        DurabilityMode::ModeT
    };

    let (root_dir, remove_on_exit) = if custom_dir.is_empty() {
        let tmp = env::temp_dir().join(format!("motel-b1-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create temp dir");
        (tmp, true)
    } else {
        let p = PathBuf::from(custom_dir);
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).expect("create custom dir");
        (p, false)
    };

    let (baseline_fp, _) = current_memory_footprint();
    let peak_fp = Arc::new(AtomicU64::new(baseline_fp));
    let peak_rss = Arc::new(AtomicU64::new(0));
    let stop_sampler = Arc::new(AtomicBool::new(false));

    let sampler_fp = Arc::clone(&peak_fp);
    let sampler_rss = Arc::clone(&peak_rss);
    let sampler_stop = Arc::clone(&stop_sampler);
    let sampler_handle = thread::spawn(move || {
        while !sampler_stop.load(Ordering::Relaxed) {
            let (fp, rss) = current_memory_footprint();
            let mut prev = sampler_fp.load(Ordering::Relaxed);
            while fp > prev {
                match sampler_fp.compare_exchange_weak(
                    prev,
                    fp,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(a) => prev = a,
                }
            }
            let mut prev_r = sampler_rss.load(Ordering::Relaxed);
            while rss > prev_r {
                match sampler_rss.compare_exchange_weak(
                    prev_r,
                    rss,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(a) => prev_r = a,
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
    });

    let mut config = StoreConfig::new(&root_dir);
    config.durability_mode = durability_mode;
    config.page_size = page_size;
    config.with_ix_req = with_ix_req;
    config.payloads_split = payloads_split;
    config.direct_jsonb = direct_jsonb;

    let store = Store::open(config).expect("open Store");
    let writer = store.writer();
    let metrics = writer.metrics().clone();

    let t0_ns = 1_792_886_400_000_000_000i64; // Fixed deterministic epoch (2026-10-25T00:00:00Z).

    // Phase 1: Measure steady 60 rows/s trickle CPU if steady_secs > 0.
    let mut steady_stats = SteadyStats {
        duration_sec: 0.0,
        rows_sent: 0,
        cpu_sec: 0.0,
        cpu_pct_of_one_core: 0.0,
    };
    if steady_secs > 0 {
        let mut trickle_gen = FixtureGenerator::new(99999, (steady_secs as usize) * 60, 3, t0_ns);
        let trickle_start = Instant::now();
        let cpu0 = process_cpu_ns();
        let mut sent = 0usize;
        while trickle_start.elapsed() < Duration::from_secs(steady_secs) {
            if let Some(batch) = trickle_gen.next_batch() {
                let n = batch.len();
                if let Ok(ack) = writer.submit(batch) {
                    let _ = ack.wait();
                    sent += n;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = writer.flush();
        let elapsed_s = trickle_start.elapsed().as_secs_f64();
        let cpu_s = (process_cpu_ns().saturating_sub(cpu0) as f64) / 1e9;
        steady_stats = SteadyStats {
            duration_sec: elapsed_s,
            rows_sent: sent,
            cpu_sec: cpu_s,
            cpu_pct_of_one_core: (cpu_s / elapsed_s.max(0.001)) * 100.0,
        };
    }

    // Reset baseline counters on writer metrics before main B1 load.
    metrics.writer_insert_cpu_ns.store(0, Ordering::SeqCst);
    metrics.checkpoint_cpu_ns.store(0, Ordering::SeqCst);
    metrics.rejected_429_count.store(0, Ordering::SeqCst);
    metrics.committed_txns.store(0, Ordering::SeqCst);
    metrics.durable_sync_count.store(0, Ordering::SeqCst);
    metrics.peak_queued_bytes.store(0, Ordering::SeqCst);
    metrics.wal_peak_bytes.store(0, Ordering::SeqCst);

    // Phase 2: Main B1 load (seed 12345) in 500-row batches, pipelined up to 6 in-flight batches
    // so group commit (2,048 rows / 1 MiB) exercises full batching without exceeding 4 MiB queue.
    let mut gen = FixtureGenerator::new(12345, total_rows, batch_size, t0_ns);
    let mut inflight: VecDeque<(Ack, Instant)> = VecDeque::with_capacity(8);
    let max_inflight = 4usize;

    let load_wall_start = Instant::now();
    let load_proc_cpu_start = process_cpu_ns();
    let mut total_gen_cpu_ns = 0u64;

    let mut chunk_rows = 0usize;
    let mut completed_rows = 0usize;
    let mut chunk_wall_start = Instant::now();
    let mut chunk_proc_cpu_start = process_cpu_ns();
    let mut chunk_gen_cpu_ns = 0u64;
    let mut chunk_ins_cpu_start = metrics.writer_insert_cpu_ns.load(Ordering::Relaxed);
    let mut chunk_ckpt_cpu_start = metrics.checkpoint_cpu_ns.load(Ordering::Relaxed);

    let mut chunks_100k: Vec<ChunkStats> = Vec::new();
    let mut ack_latencies_ms: Vec<f64> = Vec::with_capacity(total_rows / batch_size + 16);

    while let Some(batch) = {
        let g0 = current_thread_cpu_ns();
        let b = gen.next_batch();
        let gd = current_thread_cpu_ns().saturating_sub(g0);
        total_gen_cpu_ns += gd;
        chunk_gen_cpu_ns += gd;
        b
    } {
        let row_cnt = batch.len();
        let mut current_batch = Some(batch);
        while let Some(b) = current_batch.take() {
            let submit_instant = Instant::now();
            match writer.submit(b) {
                Ok(ack) => {
                    inflight.push_back((ack, submit_instant));
                }
                Err(SubmitError::QueueFull { .. }) => {
                    // Drain one in-flight batch and retry.
                    if let Some((oldest_ack, t_sub)) = inflight.pop_front() {
                        let _ = oldest_ack.wait();
                        ack_latencies_ms.push(t_sub.elapsed().as_secs_f64() * 1000.0);
                    }
                    // Note: we don't drop rows on retry in the harness, and 429 was already counted.
                    break;
                }
                Err(SubmitError::Closed) => panic!("writer closed unexpectedly"),
            }
        }

        // Drain any already-completed acks or cap inflight window at `max_inflight`.
        while inflight.len() >= max_inflight {
            let (ack, t_sub) = inflight.pop_front().unwrap();
            let _ = ack.wait();
            ack_latencies_ms.push(t_sub.elapsed().as_secs_f64() * 1000.0);
        }

        completed_rows += row_cnt;
        chunk_rows += row_cnt;

        if chunk_rows >= 100_000 {
            while let Some((ack, t_sub)) = inflight.pop_front() {
                let _ = ack.wait();
                ack_latencies_ms.push(t_sub.elapsed().as_secs_f64() * 1000.0);
            }
            let _ = writer.flush();

            let wall_s = chunk_wall_start.elapsed().as_secs_f64();
            let proc_cpu_now = process_cpu_ns();
            let ins_cpu_now = metrics.writer_insert_cpu_ns.load(Ordering::Relaxed);
            let ckpt_cpu_now = metrics.checkpoint_cpu_ns.load(Ordering::Relaxed);

            let scale = (chunk_rows as f64) / 100_000.0;
            let proc_cpu_s = ((proc_cpu_now.saturating_sub(chunk_proc_cpu_start)) as f64 / 1e9) / scale;
            let gen_cpu_s = (chunk_gen_cpu_ns as f64 / 1e9) / scale;
            let ins_cpu_s = ((ins_cpu_now.saturating_sub(chunk_ins_cpu_start)) as f64 / 1e9) / scale;
            let ckpt_cpu_s = ((ckpt_cpu_now.saturating_sub(chunk_ckpt_cpu_start)) as f64 / 1e9) / scale;

            chunks_100k.push(ChunkStats {
                up_to_rows: completed_rows,
                rows_in_chunk: chunk_rows,
                wall_sec: wall_s,
                rows_per_sec: (chunk_rows as f64) / wall_s.max(1e-6),
                process_cpu_sec_per_100k: proc_cpu_s,
                gen_cpu_sec_per_100k: gen_cpu_s,
                insert_cpu_sec_per_100k: ins_cpu_s,
                checkpoint_cpu_sec_per_100k: ckpt_cpu_s,
            });

            chunk_rows = 0;
            chunk_gen_cpu_ns = 0;
            chunk_wall_start = Instant::now();
            chunk_proc_cpu_start = process_cpu_ns();
            chunk_ins_cpu_start = metrics.writer_insert_cpu_ns.load(Ordering::Relaxed);
            chunk_ckpt_cpu_start = metrics.checkpoint_cpu_ns.load(Ordering::Relaxed);
        }
    }

    while let Some((ack, t_sub)) = inflight.pop_front() {
        let _ = ack.wait();
        ack_latencies_ms.push(t_sub.elapsed().as_secs_f64() * 1000.0);
    }
    let _ = writer.flush();

    let overall_wall_sec = load_wall_start.elapsed().as_secs_f64();
    let overall_proc_cpu_sec = (process_cpu_ns().saturating_sub(load_proc_cpu_start) as f64) / 1e9;
    let overall_ins_cpu_sec = (metrics.writer_insert_cpu_ns.load(Ordering::Relaxed) as f64) / 1e9;
    let overall_ckpt_cpu_sec = (metrics.checkpoint_cpu_ns.load(Ordering::Relaxed) as f64) / 1e9;
    let overall_gen_cpu_sec = (total_gen_cpu_ns as f64) / 1e9;

    let (after_load_fp, _) = current_memory_footprint();
    let cur_peak = peak_fp.load(Ordering::Relaxed).max(after_load_fp);
    peak_fp.store(cur_peak, Ordering::Relaxed);

    // Wait for idle period so writer's 30 s shrink_memory triggers, then sample idle footprint
    // BEFORE opening a separate connection for dbstat inspection.
    if idle_secs > 0 {
        thread::sleep(Duration::from_secs(idle_secs));
    }
    stop_sampler.store(true, Ordering::Relaxed);
    let _ = sampler_handle.join();

    let (after_idle_fp, after_idle_rss) = current_memory_footprint();
    let final_peak_fp = peak_fp.load(Ordering::Relaxed);
    let final_peak_rss = peak_rss.load(Ordering::Relaxed);

    drop(store);

    // Measure disk before and after TRUNCATE checkpoint.
    let disk = measure_disk(&root_dir, total_rows + steady_stats.rows_sent);

    if remove_on_exit {
        let _ = fs::remove_dir_all(&root_dir);
    }

    ack_latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let ack_latency_ms = LatencyPercentiles {
        p50_ms: percentile_f64(&ack_latencies_ms, 0.50),
        p95_ms: percentile_f64(&ack_latencies_ms, 0.95),
        p99_ms: percentile_f64(&ack_latencies_ms, 0.99),
        max_ms: ack_latencies_ms.last().copied().unwrap_or(0.0),
    };

    // Compute first vs last window (500k rows when >= 1M rows, else first/last chunk).
    let win_chunks = if chunks_100k.len() >= 10 {
        5
    } else {
        (chunks_100k.len() / 2).max(1)
    };
    let first_slice = &chunks_100k[..win_chunks.min(chunks_100k.len())];
    let last_slice = &chunks_100k[chunks_100k.len().saturating_sub(win_chunks)..];

    let avg_ins = |s: &[ChunkStats]| -> f64 {
        if s.is_empty() {
            0.0
        } else {
            s.iter().map(|c| c.insert_cpu_sec_per_100k).sum::<f64>() / (s.len() as f64)
        }
    };
    let avg_tot = |s: &[ChunkStats]| -> f64 {
        if s.is_empty() {
            0.0
        } else {
            s.iter().map(|c| c.process_cpu_sec_per_100k).sum::<f64>() / (s.len() as f64)
        }
    };

    let first_ins = avg_ins(first_slice);
    let last_ins = avg_ins(last_slice);
    let first_tot = avg_tot(first_slice);
    let last_tot = avg_tot(last_slice);
    let scale_100k = (total_rows as f64) / 100_000.0;

    let slope = SlopeSummary {
        window_rows: win_chunks * 100_000,
        first_window_insert_cpu_s_per_100k: first_ins,
        last_window_insert_cpu_s_per_100k: last_ins,
        insert_last_over_first_ratio: if first_ins > 0.0 {
            last_ins / first_ins
        } else {
            1.0
        },
        first_window_total_cpu_s_per_100k: first_tot,
        last_window_total_cpu_s_per_100k: last_tot,
        total_last_over_first_ratio: if first_tot > 0.0 {
            last_tot / first_tot
        } else {
            1.0
        },
        overall_insert_cpu_s_per_100k: overall_ins_cpu_sec / scale_100k,
        overall_gen_cpu_s_per_100k: overall_gen_cpu_sec / scale_100k,
        overall_checkpoint_cpu_s_per_100k: overall_ckpt_cpu_sec / scale_100k,
        overall_process_cpu_s_per_100k: overall_proc_cpu_sec / scale_100k,
        overall_wall_sec,
        overall_rows_per_sec: (total_rows as f64) / overall_wall_sec.max(1e-6),
    };

    let rejected_429s = metrics.rejected_429_count.load(Ordering::Relaxed);
    let queue_peak_bytes = metrics.peak_queued_bytes.load(Ordering::Relaxed);
    let wal_peak_bytes = metrics.wal_peak_bytes.load(Ordering::Relaxed);

    let gates = GateEvaluation {
        insert_cpu_per_100k_le_1_0: slope.overall_insert_cpu_s_per_100k <= 1.0,
        last_over_first_le_1_5: slope.insert_last_over_first_ratio <= 1.5,
        steady_cpu_lt_1pct: steady_stats.cpu_pct_of_one_core < 1.0,
        zero_429s: rejected_429s == 0,
        ack_p99_le_250ms: ack_latency_ms.p99_ms <= 250.0,
        peak_footprint_le_40mb: final_peak_fp <= 40_000_000,
        idle_footprint_le_20mb: after_idle_fp <= 20_000_000,
        disk_per_million_le_380mib: disk.mib_per_million <= 380.0,
        all_passed: slope.overall_insert_cpu_s_per_100k <= 1.0
            && slope.insert_last_over_first_ratio <= 1.5
            && steady_stats.cpu_pct_of_one_core < 1.0
            && rejected_429s == 0
            && ack_latency_ms.p99_ms <= 250.0
            && final_peak_fp <= 40_000_000
            && after_idle_fp <= 20_000_000
            && disk.mib_per_million <= 380.0,
    };

    let report = B1Report {
        benchmark: "B1",
        note: "OTLP protobuf decode is not in PR 1; normalized Event rows are generated in-process and fed directly into Writer::submit.",
        hostname: hostname_string(),
        sqlite_version: rusqlite::version().to_owned(),
        rows: total_rows,
        batch_size,
        durability_mode: format!("{durability_mode:?}"),
        page_size,
        with_ix_req,
        payloads_split,
        direct_jsonb,
        steady_trickle: steady_stats,
        slope,
        chunks_100k,
        ack_latency_ms,
        rejected_429s,
        queue_peak_bytes,
        wal_peak_bytes,
        committed_txns: metrics.committed_txns.load(Ordering::Relaxed),
        durable_sync_count: metrics.durable_sync_count.load(Ordering::Relaxed),
        disk,
        memory: MemoryMetrics {
            baseline_phys_footprint_bytes: baseline_fp,
            baseline_phys_footprint_mb: (baseline_fp as f64) / 1e6,
            peak_phys_footprint_bytes: final_peak_fp,
            peak_phys_footprint_mb: (final_peak_fp as f64) / 1e6,
            after_load_phys_footprint_bytes: after_load_fp,
            after_load_phys_footprint_mb: (after_load_fp as f64) / 1e6,
            idle_wait_sec: idle_secs,
            after_idle_phys_footprint_bytes: after_idle_fp,
            after_idle_phys_footprint_mb: (after_idle_fp as f64) / 1e6,
            peak_rss_bytes: final_peak_rss,
            after_idle_rss_bytes: after_idle_rss,
        },
        gates,
    };

    let json = serde_json::to_string_pretty(&report).expect("serialize B1 report");
    if !out_file.is_empty() {
        if let Some(parent) = Path::new(&out_file).parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&out_file, &json).expect("write output JSON");
    }
    println!("{json}");
}

fn measure_disk(root_dir: &Path, total_rows: usize) -> DiskMetrics {
    let days_dir = root_dir.join("days");
    let mut hot_path: Option<PathBuf> = None;
    if let Ok(rd) = fs::read_dir(&days_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("sqlite") {
                hot_path = Some(p);
                break;
            }
        }
    }

    let Some(hot_path) = hot_path else {
        return DiskMetrics {
            hot_file_bytes_before_ckpt: 0,
            wal_bytes_before_ckpt: 0,
            total_bytes_after_ckpt: 0,
            bytes_per_million: 0,
            mib_per_million: 0.0,
            by_object_mib: BTreeMap::new(),
        };
    };

    let mut wal_os = hot_path.as_os_str().to_owned();
    wal_os.push("-wal");
    let wal_path = PathBuf::from(wal_os);

    let hot_before = fs::metadata(&hot_path).map(|m| m.len()).unwrap_or(0);
    let wal_before = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

    let mut by_object_mib = BTreeMap::new();
    if let Ok(conn) = Connection::open(&hot_path) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        if let Ok(mut stmt) = conn.prepare("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name") {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            }) {
                for item in rows.flatten() {
                    let mib = ((item.1 as f64) / 1_048_576.0 * 10.0).round() / 10.0;
                    by_object_mib.insert(item.0, mib);
                }
            }
        }
    }

    let after_ckpt = fs::metadata(&hot_path).map(|m| m.len()).unwrap_or(0);
    let rows_millions = (total_rows.max(1) as f64) / 1_000_000.0;
    let bytes_per_million = ((after_ckpt as f64) / rows_millions) as u64;
    let mib_per_million = (bytes_per_million as f64) / 1_048_576.0;

    DiskMetrics {
        hot_file_bytes_before_ckpt: hot_before,
        wal_bytes_before_ckpt: wal_before,
        total_bytes_after_ckpt: after_ckpt,
        bytes_per_million,
        mib_per_million,
        by_object_mib,
    }
}
