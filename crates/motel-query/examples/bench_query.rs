//! p50/p95 latency of `why` and `show <trace>` over a generated store.
//!
//! `cargo run --release -p motel-query --example bench_query -- [rows] [days] [iters]`
//! (defaults: 1,000,000 rows over 8 days, 50 iterations per call).
//!
//! Rows follow the motel-bench fixture shape (5 services, 10-span traces, ~200 B bodies,
//! 3% error spans, 5% ERROR logs, 5% stamped a day before they arrive), spread evenly over
//! `days` and written day by day under a manual clock so each day gets its own file. Error
//! messages come from ~200 recurring groups, plus a handful that first appear on the last
//! day so `why` has NEW groups to find.

use std::sync::Arc;
use std::time::Instant;

use motel_query::{Answer, FindingKind, Query, Tz, WhyArgs};
use motel_store::{
    Event, EventKind, EventSource, ManualClock, Resource, Store, StoreConfig, NS_PER_DAY,
};

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
/// 2026-10-25T00:00:00Z.
const END: i64 = 1_792_886_400_000_000_000;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn error_message(rng: &mut Rng, last_day: bool) -> String {
    if last_day && rng.f() < 0.02 {
        return format!("NewError: feature flag {} missing", rng.below(4));
    }
    match rng.below(4) {
        0 => format!("upstream timeout after {}ms", 1000 + rng.below(30_000)),
        1 => format!("db timeout after 5000ms (conn {})", rng.below(64)),
        2 => format!(
            "TypeError: Cannot read properties of undefined (reading 'f{}') at /app/src/h{}.ts:{}:9",
            rng.below(10),
            rng.below(4),
            rng.below(400)
        ),
        _ => format!("connection reset by peer (peer 10.0.0.{})", rng.below(255)),
    }
}

/// One day's rows, as `(arrival, event)`, starting at `day_start`.
fn day_rows(rng: &mut Rng, day_start: i64, n: usize, last_day: bool) -> Vec<(i64, Event)> {
    let mut out = Vec::with_capacity(n);
    let mut traces: Vec<[u8; 16]> = Vec::new();
    let mut i = 0;
    while i < n {
        let arrive = day_start + (i as i64) * (NS_PER_DAY / n as i64);
        let trace = rng.next().to_be_bytes().repeat(2).try_into().unwrap();
        traces.push(trace);
        let session = format!("s{}", rng.below(2000));
        let root = rng.next().to_be_bytes();
        // A trace of 10 spans, then 10 logs pointing at recent traces.
        for k in 0..20 {
            if i >= n {
                break;
            }
            let at = arrive + k as i64 * 1_000_000;
            let ts = if rng.f() < 0.05 { at - NS_PER_DAY } else { at };
            let service = SERVICES[rng.below(5) as usize];
            let mut e = Event {
                ts,
                ingest_ts: None,
                dur: None,
                kind: EventKind::Span,
                service: service.to_owned(),
                severity: None,
                status: None,
                err: false,
                name: None,
                trace_id: Some(trace),
                span_id: Some(rng.next().to_be_bytes()),
                parent_id: None,
                session_id: Some(session.clone()),
                request_id: (rng.f() < 0.2).then(|| format!("{:012x}", rng.below(1 << 48))),
                resource: Some(Resource {
                    host: Some("bench-host".to_owned()),
                    service: service.to_owned(),
                    version: Some("0.1.0".to_owned()),
                    pid: Some(4000 + rng.below(5) as i64),
                    attrs: None,
                }),
                src: EventSource::Otlp,
                artifact: None,
                body: None,
                attrs: None,
            };
            if k < 10 {
                e.err = rng.f() < 0.03;
                e.dur = Some((1 + rng.below(200) as i64) * 1_000_000);
                e.name = Some(OPS[rng.below(8) as usize].to_owned());
                e.status = Some(if e.err { "error" } else { "ok" }.to_owned());
                if k == 0 {
                    e.span_id = Some(root);
                } else {
                    e.parent_id = Some(root);
                }
                let msg = if e.err {
                    format!(r#","exception.message":"{}""#, error_message(rng, last_day))
                } else {
                    String::new()
                };
                e.attrs = Some(format!(
                    r#"{{"http.route":"{}","user.id":"u{}"{msg}}}"#,
                    OPS[rng.below(8) as usize],
                    rng.below(1000)
                ));
            } else {
                e.kind = EventKind::Log;
                e.trace_id = Some(
                    traces[traces.len() - 1 - rng.below(traces.len().min(64) as u64) as usize],
                );
                e.span_id = None;
                e.err = rng.f() < 0.05;
                e.severity = Some(if e.err { 17 } else { 9 });
                e.body = Some(if e.err {
                    error_message(rng, last_day)
                } else {
                    format!(
                        "{} ok id={:08x} user=u{} {}",
                        OPS[rng.below(8) as usize],
                        rng.below(1 << 32),
                        rng.below(1000),
                        "x".repeat(140)
                    )
                });
            }
            out.push((at, e));
            i += 1;
        }
    }
    out
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_bytes(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn pct(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    let at = |p: f64| v[((v.len() as f64 - 1.0) * p).round() as usize];
    (at(0.5), at(0.95), v[v.len() - 1])
}

fn time<T>(iters: usize, mut f: impl FnMut(usize) -> T) -> (f64, f64, f64, f64) {
    let t = Instant::now();
    let _ = f(0);
    let cold = t.elapsed().as_secs_f64() * 1e3;
    let v = (0..iters)
        .map(|i| {
            let t = Instant::now();
            let _ = f(i);
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    let (p50, p95, max) = pct(v);
    (cold, p50, p95, max)
}

fn main() {
    let args: Vec<usize> = std::env::args()
        .skip(1)
        .map(|a| a.parse().unwrap())
        .collect();
    let rows = args.first().copied().unwrap_or(1_000_000);
    let days = args.get(1).copied().unwrap_or(8);
    let iters = args.get(2).copied().unwrap_or(50);

    let dir = std::env::temp_dir().join(format!("motel-query-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let start = END - days as i64 * NS_PER_DAY;
    let clock = Arc::new(ManualClock::new(start));
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();

    let t = Instant::now();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut trace_ids = Vec::new();
    let mut acks: Vec<motel_store::Ack> = Vec::new();
    for d in 0..days {
        let rows_today = rows / days + usize::from(d < rows % days);
        let batch = day_rows(
            &mut rng,
            start + d as i64 * NS_PER_DAY,
            rows_today,
            d + 1 == days,
        );
        for chunk in batch.chunks(500) {
            clock.set_ns(chunk[chunk.len() - 1].0);
            let evs: Vec<Event> = chunk
                .iter()
                .map(|(at, e)| {
                    let mut e = e.clone();
                    e.ingest_ts = Some(*at);
                    e
                })
                .collect();
            if d + 1 == days {
                trace_ids.extend(
                    evs.iter()
                        .filter(|e| e.parent_id.is_none() && e.kind == EventKind::Span)
                        .filter_map(|e| e.trace_id),
                );
            }
            if acks.len() >= 16 {
                acks.remove(0).wait().unwrap();
            }
            acks.push(writer.submit(evs).unwrap());
        }
        // A day's batches commit before the clock moves to the next day.
        for ack in acks.drain(..) {
            ack.wait().unwrap();
        }
    }
    clock.set_ns(END + 60_000_000_000);
    writer.wait_for_seals().unwrap();
    store.reader().refresh_catalog().unwrap();
    let bytes = dir_bytes(&dir);
    println!(
        "fixture: {rows} rows over {days} days, {:.0} MiB, written in {:.1}s",
        bytes as f64 / 1048576.0,
        t.elapsed().as_secs_f64()
    );

    let q = Query::new(store.reader(), "bench-host").with_tz(Tz::Fixed(0));
    let w = q
        .why(&WhyArgs {
            limit: 10_000,
            ..Default::default()
        })
        .unwrap();
    let count = |k: FindingKind| w.findings.iter().filter(|f| f.kind == k).count();
    println!(
        "why: {} error events in 24h -> {} NEW groups, {} recurring",
        w.totals.error_events,
        count(FindingKind::New),
        count(FindingKind::Recurring)
    );
    let sample = q
        .show(&hex(&trace_ids[trace_ids.len() / 2]), false)
        .unwrap();
    println!("show trace: {} lines", sample.text().lines().count());

    let report = |name: &str, (cold, p50, p95, max): (f64, f64, f64, f64)| {
        println!(
            "{name:<28} first {cold:>7.1}ms  p50 {p50:>7.1}ms  p95 {p95:>7.1}ms  max {max:>7.1}ms"
        );
    };
    report(
        "why (24h)",
        time(iters, |_| q.why(&WhyArgs::default()).unwrap().text()),
    );
    report(
        "why api (24h)",
        time(iters, |_| {
            q.why(&WhyArgs {
                service: Some("api".to_owned()),
                ..Default::default()
            })
            .unwrap()
            .text()
        }),
    );
    report(
        "why --since 7d",
        time(iters, |_| {
            q.why(&WhyArgs {
                since: Some(q.now_ns() - 7 * NS_PER_DAY),
                ..Default::default()
            })
            .unwrap()
            .text()
        }),
    );
    let step = (trace_ids.len() / (iters + 1)).max(1);
    report(
        "show <trace> (last day)",
        time(iters, |i| {
            q.show(&hex(&trace_ids[(i * step) % trace_ids.len()]), false)
                .unwrap()
                .text()
        }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}
