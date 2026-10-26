//! A seeded store for the query tests.
//!
//! "Now" is 2026-10-25 15:00:00 UTC and every time below is relative to it. Rows are written
//! day by day with a manual clock, so they land in the day file of their arrival, the way
//! the daemon writes them. Contents:
//!
//! - `api`: 6 days of `db.query` spans (~300 ms) for p50s; a recurring `db timeout` error
//!   group (2 baseline hits, 4 in the last 24 h); an `upstream rate limited` group at -5h
//!   and -1h; a NEW `TypeError` span group after the fake commit at -3h, in 3 traces of
//!   session `ses_demo1`; a 260-span batch trace for the line cap.
//! - Late arrivals: a `disk quota` error stamped -20h and a `queue.push` child span stamped
//!   -16h, both arriving at -30m (today's file).
//! - `worker`: a crash at -2h with pid 4242, breadcrumbs from pid 4242 and noise from pid 99.
//! - `cargo`: a failed `cargo test -p api` run at -90m (exit 101, 2 failed tests) whose
//!   trace holds slow `db.query` spans; an older passing run at -2d.
//! - `batch`: info logs only, 3 days ago (quiet). `cron`: one error 5 days ago (walk-back).

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use motel_query::{Query, Tz};
use motel_store::{
    Event, EventKind, EventSource, ManualClock, Resource, Store, StoreConfig, NS_PER_DAY,
    NS_PER_HOUR, NS_PER_SECOND,
};

pub const S: i64 = NS_PER_SECOND;
pub const MS: i64 = 1_000_000;
pub const M: i64 = 60 * S;
pub const H: i64 = NS_PER_HOUR;
pub const D: i64 = NS_PER_DAY;
/// 2026-10-25T15:00:00Z.
pub const NOW: i64 = 1_792_940_400 * S;
/// The fake commit the `--since` tests resolve to.
pub const COMMIT: i64 = NOW - 3 * H;

pub const T1: [u8; 16] = trace(0x4b);
pub const T_LATE: [u8; 16] = trace(0x5c);
pub const T_RUN: [u8; 16] = trace(0x6d);
pub const T_BIG: [u8; 16] = trace(0x7e);

pub const fn trace(seed: u8) -> [u8; 16] {
    let mut t = [0u8; 16];
    let mut i = 0;
    while i < 16 {
        t[i] = seed.wrapping_mul(i as u8 + 1).wrapping_add(i as u8 * 17);
        i += 1;
    }
    t
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub struct Fixture {
    pub dir: PathBuf,
    pub store: Store,
    pub clock: Arc<ManualClock>,
}

impl Fixture {
    pub fn query(&self) -> Query {
        Query::new(self.store.reader(), "devbox").with_tz(Tz::Fixed(0))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "motel-query-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One row plus the time it reaches motel.
pub struct Row {
    pub arrive: i64,
    pub ev: Event,
}

pub fn ev(ts: i64, kind: EventKind, service: &str) -> Event {
    Event {
        ts,
        ingest_ts: None,
        dur: None,
        kind,
        service: service.to_owned(),
        severity: None,
        status: None,
        err: false,
        name: None,
        trace_id: None,
        span_id: None,
        parent_id: None,
        session_id: None,
        request_id: None,
        resource: Some(res(service, 1000)),
        src: EventSource::Otlp,
        artifact: None,
        body: None,
        attrs: None,
    }
}

pub fn res(service: &str, pid: i64) -> Resource {
    Resource {
        host: Some("devbox".to_owned()),
        service: service.to_owned(),
        version: Some("1.4.2".to_owned()),
        pid: Some(pid),
        attrs: None,
    }
}

pub fn log(ts: i64, service: &str, severity: i32, body: &str) -> Event {
    let mut e = ev(ts, EventKind::Log, service);
    e.severity = Some(severity);
    e.body = Some(body.to_owned());
    e
}

pub fn span(
    ts: i64,
    service: &str,
    name: &str,
    dur: i64,
    trace: [u8; 16],
    span_id: u64,
    parent: Option<u64>,
) -> Event {
    let mut e = ev(ts, EventKind::Span, service);
    e.name = Some(name.to_owned());
    e.dur = Some(dur);
    e.trace_id = Some(trace);
    e.span_id = Some(span_id.to_be_bytes());
    e.parent_id = parent.map(u64::to_be_bytes);
    e.status = Some("ok".to_owned());
    e
}

/// Rows arrive when they happen unless `arrive` says otherwise.
fn at(ev: Event) -> Row {
    Row { arrive: ev.ts, ev }
}

pub fn rows() -> Vec<Row> {
    let mut rows = Vec::new();
    let mut sid = 0x100u64;
    let mut next_sid = || {
        sid += 1;
        sid
    };

    // api: a week of db.query spans for p50s.
    for day in 1..=6 {
        for i in 0..5 {
            let ts = NOW - day * D + i * 7 * M;
            let t = trace(0x20 + (day * 5 + i) as u8);
            rows.push(at(span(
                ts,
                "api",
                "db.query",
                (280 + i * 10) * MS,
                t,
                next_sid(),
                None,
            )));
        }
    }

    // Recurring: db timeouts (numbers and the host vary).
    for (ago, conn) in [
        (4 * D, 17),
        (2 * D, 3),
        (6 * H, 9),
        (4 * H, 21),
        (150 * M, 4),
        (50 * M, 12),
    ] {
        rows.push(at(log(
            NOW - ago,
            "api",
            17,
            &format!("db timeout after 5000ms (conn {conn}, host 10.0.0.{conn})"),
        )));
    }

    // NEW in the 24 h window, recurring relative to the commit.
    for ago in [5 * H, H] {
        rows.push(at(log(
            NOW - ago,
            "api",
            17,
            "upstream rate limited: retry in 30s",
        )));
    }

    // NEW after the commit: TypeError in users.load, three traces of one session.
    for (n, ago) in [(0u8, 160 * M), (1, 90 * M), (2, 20 * M)] {
        let t = if n == 2 { T1 } else { trace(0x40 + n) };
        let start = NOW - ago;
        let root = next_sid();
        let mut r = span(start, "api", "GET /users/:id", 182 * MS, t, root, None);
        r.session_id = Some("ses_demo1".to_owned());
        r.request_id = Some(format!("req-7f3a{n}"));
        r.attrs = Some(r#"{"http.route":"/users/:id","http.status_code":500}"#.to_owned());
        rows.push(at(r));

        let mut l = log(
            start + MS,
            "api",
            9,
            &format!("GET /users/{} start", 8810 + n as i32),
        );
        l.trace_id = Some(t);
        l.span_id = Some(root.to_be_bytes());
        l.session_id = Some("ses_demo1".to_owned());
        rows.push(at(l));

        let mut a = span(
            start + 2 * MS,
            "auth",
            "auth.check",
            12 * MS,
            t,
            next_sid(),
            Some(root),
        );
        a.session_id = Some("ses_demo1".to_owned());
        rows.push(at(a));

        let mut q = span(
            start + 15 * MS,
            "api",
            "db.query",
            140 * MS,
            t,
            next_sid(),
            Some(root),
        );
        q.session_id = Some("ses_demo1".to_owned());
        rows.push(at(q));

        let load = next_sid();
        let mut u = span(
            start + 156 * MS,
            "api",
            "users.load",
            25 * MS,
            t,
            load,
            Some(root),
        );
        u.status = Some("error".to_owned());
        u.session_id = Some("ses_demo1".to_owned());
        u.body = Some(format!(
            "TypeError: Cannot read properties of undefined (reading 'id') at /srv/api/src/users.ts:{}:17",
            42 + n as i32
        ));
        rows.push(at(u));

        let mut w = log(
            start + 170 * MS,
            "api",
            13,
            &format!("user cache miss for {}", 8810 + n as i32),
        );
        w.trace_id = Some(t);
        w.span_id = Some(load.to_be_bytes());
        w.session_id = Some("ses_demo1".to_owned());
        rows.push(at(w));
    }

    // Late arrivals: stamped yesterday, written to today's file at -30m.
    rows.push(Row {
        arrive: NOW - 30 * M,
        ev: log(
            NOW - 20 * H,
            "api",
            17,
            "disk quota exceeded on /var/lib/api/cache",
        ),
    });
    let late_root = next_sid();
    rows.push(at(span(
        NOW - 16 * H,
        "api",
        "POST /jobs",
        2100 * MS,
        T_LATE,
        late_root,
        None,
    )));
    rows.push(Row {
        arrive: NOW - 30 * M,
        ev: span(
            NOW - 16 * H + 40 * MS,
            "worker",
            "queue.push",
            30 * MS,
            T_LATE,
            next_sid(),
            Some(late_root),
        ),
    });

    // worker: breadcrumbs, a crash, a restart.
    let crash_at = NOW - 2 * H;
    for (before, pid, sev, body) in [
        (90 * S, 4242, 9, "job 17 started"),
        (40 * S, 4242, 13, "queue depth 3 above soft limit"),
        (30 * S, 99, 9, "heartbeat from the other worker"),
        (5 * S, 4242, 9, "popping job 18"),
    ] {
        let mut l = log(crash_at - before, "worker", sev, body);
        l.resource = Some(res("worker", pid));
        rows.push(at(l));
    }
    let mut crash = ev(crash_at, EventKind::Crash, "worker");
    crash.name = Some("panic".to_owned());
    crash.resource = Some(res("worker", 4242));
    crash.artifact = Some("crashes/worker-4242.txt".to_owned());
    crash.body = Some(
        "thread 'main' panicked at 'index out of bounds: the len is 3 but the index is 7', src/queue.rs:88:14\n\
         stack backtrace:\n\
            0: rust_begin_unwind\n\
            1: core::panicking::panic_fmt\n\
            2: core::panicking::panic_bounds_check\n\
            3: worker::queue::Queue::pop\n\
            4: worker::run_loop\n\
            5: worker::main"
            .to_owned(),
    );
    rows.push(at(crash));
    let mut restart = log(
        crash_at + 10 * S,
        "worker",
        9,
        "worker restarted (pid 4300)",
    );
    restart.resource = Some(res("worker", 4300));
    rows.push(at(restart));

    // cargo: an older passing run, then the failed one with slow spans and failed tests.
    let mut ok_run = ev(NOW - 2 * D, EventKind::Run, "cargo");
    ok_run.name = Some("cargo test -p api".to_owned());
    ok_run.status = Some("pass".to_owned());
    ok_run.dur = Some(61 * S);
    ok_run.attrs = Some(r#"{"run.command":"cargo test -p api","exit_code":0}"#.to_owned());
    rows.push(at(ok_run));

    let run_at = NOW - 90 * M;
    let mut run = ev(run_at, EventKind::Run, "cargo");
    run.name = Some("cargo test -p api".to_owned());
    run.status = Some("fail".to_owned());
    run.dur = Some(95 * S);
    run.trace_id = Some(T_RUN);
    run.attrs = Some(r#"{"run.command":"cargo test -p api","exit_code":101}"#.to_owned());
    rows.push(at(run));
    let run_root = next_sid();
    rows.push(at(span(
        run_at + S,
        "api",
        "test suite",
        93 * S,
        T_RUN,
        run_root,
        None,
    )));
    for (off, name, dur) in [
        (2 * S, "fixtures.load", 600 * MS),
        (10 * S, "db.query", 2400 * MS),
        (20 * S, "db.query", 1900 * MS),
        (30 * S, "http.request GET /users", 800 * MS),
    ] {
        rows.push(at(span(
            run_at + off,
            "api",
            name,
            dur,
            T_RUN,
            next_sid(),
            Some(run_root),
        )));
    }
    for (off, name, status, body) in [
        (35 * S, "users::create_ok", "pass", None),
        (
            40 * S,
            "users::create_rejects_dupes",
            "fail",
            Some("assertion `left == right` failed\n  left: 201\n right: 409"),
        ),
        (
            52 * S,
            "users::get_missing_returns_404",
            "fail",
            Some("called `Option::unwrap()` on a `None` value"),
        ),
    ] {
        let mut t = ev(run_at + off, EventKind::Test, "cargo");
        t.name = Some(name.to_owned());
        t.status = Some(status.to_owned());
        t.body = body.map(str::to_owned);
        rows.push(at(t));
    }

    // A 260-span trace for the line cap.
    let big_root = next_sid();
    let big_at = NOW - 10 * H;
    rows.push(at(span(
        big_at,
        "api",
        "batch.import",
        9 * S,
        T_BIG,
        big_root,
        None,
    )));
    for i in 0..259 {
        rows.push(at(span(
            big_at + (i + 1) * 30 * MS,
            "api",
            "batch.item",
            20 * MS,
            T_BIG,
            next_sid(),
            Some(big_root),
        )));
    }

    // Quiet and walk-back services.
    for i in 0..3 {
        rows.push(at(log(
            NOW - 3 * D + i * M,
            "batch",
            9,
            "nightly import ok",
        )));
    }
    rows.push(at(log(
        NOW - 5 * D,
        "cron",
        17,
        "job nightly-backup failed: exit status 2",
    )));

    // The newest write: a heartbeat two minutes ago.
    rows.push(at(log(NOW - 2 * M, "api", 9, "health ok")));
    rows
}

/// Open a store at `NOW` and write `rows` day by day in arrival order.
pub fn seeded_with(label: &str, mut rows: Vec<Row>) -> Fixture {
    let dir = temp_dir(label);
    let first = rows.iter().map(|r| r.arrive).min().unwrap_or(NOW);
    let clock = Arc::new(ManualClock::new(first));
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();

    rows.sort_by_key(|r| r.arrive);
    let mut i = 0;
    while i < rows.len() {
        let day = rows[i].arrive.div_euclid(D);
        let mut batch = Vec::new();
        let mut last = rows[i].arrive;
        while i < rows.len() && rows[i].arrive.div_euclid(D) == day {
            let mut e = rows[i].ev.clone();
            e.ingest_ts = Some(rows[i].arrive);
            last = rows[i].arrive;
            batch.push(e);
            i += 1;
        }
        clock.set_ns(last);
        for chunk in batch.chunks(500) {
            writer.submit(chunk.to_vec()).unwrap().wait().unwrap();
        }
    }
    clock.set_ns(NOW);
    writer.wait_for_seals().unwrap();
    store.reader().refresh_catalog().unwrap();
    Fixture { dir, store, clock }
}

pub fn seeded(label: &str) -> Fixture {
    seeded_with(label, rows())
}

pub fn empty(label: &str) -> Fixture {
    seeded_with(label, Vec::new())
}
