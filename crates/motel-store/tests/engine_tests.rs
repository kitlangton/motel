use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use motel_store::{
    check_sqlite_version_number, Clock, CursorUpdate, DayFileState, DurabilityMode, Event,
    EventKind, EventSource, ManualClock, Reader, Resource, SqlValue, Store, StoreConfig,
    StoreError, SubmitError, TimeWindow, MIN_SQLITE_VERSION_NUMBER, NS_PER_DAY, NS_PER_HOUR,
    NS_PER_SECOND,
};
use rusqlite::Connection;

fn temp_test_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "motel-store-test-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sample_event(ts: i64, service: &str, kind: EventKind, err: bool) -> Event {
    Event {
        ts,
        ingest_ts: None,
        dur: Some(5_000_000),
        kind,
        service: service.to_owned(),
        severity: if kind == EventKind::Log {
            Some(if err { 17 } else { 9 })
        } else {
            None
        },
        status: Some(if err { "error" } else { "ok" }.to_owned()),
        err,
        name: Some("GET /users".to_owned()),
        trace_id: Some([1u8; 16]),
        span_id: Some([2u8; 8]),
        parent_id: None,
        session_id: Some("sess-1".to_owned()),
        request_id: Some("req-1".to_owned()),
        resource: Some(Resource {
            host: Some("test-host".to_owned()),
            service: service.to_owned(),
            version: Some("1.0.0".to_owned()),
            pid: Some(1234),
            attrs: Some(r#"{"service.name":"api","env":"test"}"#.to_owned()),
        }),
        src: EventSource::Otlp,
        artifact: None,
        body: Some("GET /users ok".to_owned()),
        attrs: Some(r#"{"http.route":"/users","http.status_code":200}"#.to_owned()),
    }
}

#[test]
fn sqlite_version_floor_and_compile_options() {
    assert!(rusqlite::version_number() >= MIN_SQLITE_VERSION_NUMBER);
    assert!(check_sqlite_version_number(3_051_003).is_ok());
    assert!(matches!(
        check_sqlite_version_number(3_051_002),
        Err(StoreError::SqliteVersionTooOld { .. })
    ));

    let conn = Connection::open_in_memory().unwrap();
    let mut stmt = conn.prepare("PRAGMA compile_options").unwrap();
    let opts: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(
        opts.iter().any(|o| o == "MAX_ATTACHED=32"),
        "expected MAX_ATTACHED=32 in {opts:?}"
    );
    assert!(
        opts.iter().any(|o| o == "OMIT_LOAD_EXTENSION"),
        "expected OMIT_LOAD_EXTENSION in {opts:?}"
    );
    assert!(
        opts.iter().any(|o| o == "ENABLE_MEMORY_MANAGEMENT"),
        "expected ENABLE_MEMORY_MANAGEMENT in {opts:?}"
    );
}

#[test]
fn group_commit_ack_and_queue_backpressure() {
    let dir = temp_test_dir("group-commit");
    let t0 = 1_792_886_400 * NS_PER_SECOND; // 2026-10-25T00:00:00Z
    let clock = Arc::new(ManualClock::new(t0));

    let mut cfg = StoreConfig::new(&dir);
    cfg.group_commit_interval = Duration::from_millis(40);
    cfg.group_commit_max_rows = 100;
    cfg.queue_byte_budget = 8192; // Small budget (8 KiB) to test 429 QueueFull backpressure.

    let store = Store::open_with_clock(cfg, clock.clone()).unwrap();
    let writer = store.writer();

    // 1. Test queue byte budget returning SubmitError::QueueFull (429).
    let huge_batch: Vec<Event> = (0..30)
        .map(|i| {
            let mut ev = sample_event(t0 + i * 1000, "api", EventKind::Log, false);
            ev.body = Some("x".repeat(512));
            ev
        })
        .collect();
    let err = writer.submit(huge_batch).err().expect("expected QueueFull");
    assert_eq!(err, SubmitError::QueueFull { retry_after_secs: 1 });
    assert_eq!(
        writer
            .metrics()
            .rejected_429_count
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );

    // 2. Test pipelined submissions coalescing into a single group commit transaction.
    let mut acks = Vec::new();
    for b in 0..5 {
        let rows: Vec<Event> = (0..5)
            .map(|i| sample_event(t0 + (b * 5 + i) * 1000, "api", EventKind::Span, false))
            .collect();
        acks.push(writer.submit(rows).unwrap());
    }
    for ack in acks {
        let res = ack.wait().unwrap();
        assert_eq!(res.day, "2026-10-25");
        assert_eq!(res.rows_committed, 5);
    }

    // 5 small batches submitted back-to-back within 40ms should coalesce into fewer than 5 commits.
    let txns = writer
        .metrics()
        .committed_txns
        .load(std::sync::atomic::Ordering::Relaxed);
    assert!((1..5).contains(&txns), "expected group commit coalescing, got {txns} txns");

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn jsonb_attr_scalar_and_resource_lru_interning() {
    let dir = temp_test_dir("jsonb-lru");
    let t0 = 1_792_886_400 * NS_PER_SECOND;
    let clock = Arc::new(ManualClock::new(t0));
    let mut cfg = StoreConfig::new(&dir);
    cfg.durability_mode = DurabilityMode::ModeF;

    let store = Store::open_with_clock(cfg, clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();

    // Submit 10 events sharing only 2 distinct resources, with dotted JSONB keys.
    let mut events = Vec::new();
    for i in 0..10 {
        let svc = if i % 2 == 0 { "api" } else { "worker" };
        let mut ev = sample_event(t0 + i * 1_000_000, svc, EventKind::Span, i == 3);
        ev.span_id = Some([i as u8; 8]);
        ev.attrs = Some(format!(
            r#"{{"http.route":"/v1/items/{i}","http.status_code":{},"nested.dotted.key":"val-{i}"}}"#,
            if i == 3 { 500 } else { 200 }
        ));
        events.push(ev);
    }
    writer.submit(events).unwrap().wait().unwrap();
    clock.advance_ns(20 * 1_000_000);

    // Verify `by_attr` primitive with dotted key.
    let res = reader.by_attr("http.route", "/v1/items/3", 10, None).unwrap();
    assert_eq!(res.rows.len(), 1);
    assert_eq!(res.rows[0].ts, t0 + 3 * 1_000_000);
    assert!(res.rows[0].err);

    // Verify integer attribute lookup via `by_attr` and `sql`.
    let res_code = reader.by_attr("http.status_code", "500", 10, None).unwrap();
    assert_eq!(res_code.rows.len(), 1);

    let sql_res = reader
        .sql(
            "SELECT attr(attrs, 'nested.dotted.key') AS k, COUNT(DISTINCT res) AS rcount FROM events WHERE attr(attrs, 'http.status_code') = 200",
            None,
        )
        .unwrap();
    assert_eq!(sql_res.rows.len(), 1);
    assert_eq!(
        sql_res.rows[0].columns.get("rcount"),
        Some(&SqlValue::Integer(2))
    );

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn evidence_routing_and_cursors_in_same_txn() {
    let dir = temp_test_dir("evidence-cursors");
    let t0 = 1_792_886_400 * NS_PER_SECOND;
    let clock = Arc::new(ManualClock::new(t0));
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();

    let span_ev = sample_event(t0 + 1000, "api", EventKind::Span, false);
    let pass_test = {
        let mut e = sample_event(t0 + 2000, "ci", EventKind::Test, false);
        e.status = Some("pass".to_owned());
        e
    };
    let fail_test = {
        let mut e = sample_event(t0 + 3000, "ci", EventKind::Test, true);
        e.status = Some("fail".to_owned());
        e
    };
    let crash_ev = sample_event(t0 + 4000, "app", EventKind::Crash, true);
    let run_ev = sample_event(t0 + 5000, "hivemind", EventKind::Run, false);

    let cursors = vec![
        CursorUpdate {
            source: "opencode.log".to_owned(),
            dev: Some(1),
            ino: Some(100),
            head_hash: Some(vec![0xaa, 0xbb]),
            offset: 4096,
            updated_ingest_ts: t0 + 5000,
            is_evidence: false,
        },
        CursorUpdate {
            source: "diag.ips".to_owned(),
            dev: Some(1),
            ino: Some(200),
            head_hash: None,
            offset: 13_000,
            updated_ingest_ts: t0 + 6000,
            is_evidence: true,
        },
    ];

    writer
        .submit_with_cursors(
            vec![span_ev, pass_test, fail_test, crash_ev, run_ev],
            cursors,
        )
        .unwrap()
        .wait()
        .unwrap();
    clock.advance_ns(10_000);

    let snap = store.catalog_snapshot();
    // span_ev and pass_test go to the day file (2 rows); fail_test, crash_ev, run_ev go to evidence.sqlite (3 rows).
    assert_eq!(snap.days.get("2026-10-25").unwrap().rows, 2);
    assert_eq!(snap.evidence.as_ref().unwrap().rows, 3);

    // Check cursors across files.
    let c1 = store.latest_cursor("opencode.log").unwrap().unwrap();
    assert_eq!(c1.offset, 4096);
    assert!(!c1.is_evidence);

    let c2 = store.latest_cursor("diag.ips").unwrap().unwrap();
    assert_eq!(c2.offset, 13_000);
    assert!(c2.is_evidence);

    // Querying errors for "ci" finds the failed test in evidence.sqlite with id "evidence:1".
    let ci_errs = reader.recent_errors("ci", 10, None).unwrap();
    assert_eq!(ci_errs.rows.len(), 1);
    assert!(ci_errs.rows[0].id.starts_with("evidence:"));

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn day_roll_at_midnight_and_seal_idempotence_every_step() {
    // Test stopping after each seal step 1..=5, then reopening Store and verifying
    // startup recovery completes the seal idempotently into D.sqlite (engine.md §2.5, §3.4).
    for stop_step in 1u8..=5u8 {
        let dir = temp_test_dir(&format!("seal-step-{stop_step}"));
        let day1_ts = 1_792_886_400 * NS_PER_SECOND + 10 * NS_PER_HOUR; // 2026-10-25 10:00 UTC
        let day2_ts = day1_ts + NS_PER_DAY; // 2026-10-26 10:00 UTC
        let clock = Arc::new(ManualClock::new(day1_ts));

        {
            let mut cfg = StoreConfig::new(&dir);
            cfg.seal_stop_after_step = Some(stop_step);
            let store = Store::open_with_clock(cfg, clock.clone()).unwrap();
            let writer = store.writer();

            // Write 20 rows on day 1 (2026-10-25).
            let day1_rows: Vec<Event> = (0..20)
                .map(|i| sample_event(day1_ts + i * 1_000_000, "api", EventKind::Span, i % 5 == 0))
                .collect();
            writer.submit(day1_rows).unwrap().wait().unwrap();

            // Roll clock to day 2 (2026-10-26) and write 10 rows.
            clock.set_ns(day2_ts);
            let day2_rows: Vec<Event> = (0..10)
                .map(|i| sample_event(day2_ts + i * 1_000_000, "api", EventKind::Log, false))
                .collect();
            writer.submit(day2_rows).unwrap().wait().unwrap();
            writer.wait_for_seals().unwrap();

            // Because seal_stop_after_step == Some(stop_step), 2026-10-25.hot.sqlite was stopped mid-seal!
            assert!(
                dir.join("days/2026-10-25.hot.sqlite").exists(),
                "step {stop_step}: expected hot file to still exist beforefinal rename"
            );
            assert!(
                !dir.join("days/2026-10-25.sqlite").exists(),
                "step {stop_step}: expected sealed file to not exist yet"
            );
        }

        // Now reopen Store on day 2 with normal config: startup recovery must finish sealing 2026-10-25!
        {
            let cfg = StoreConfig::new(&dir);
            let store = Store::open_with_clock(cfg, clock.clone()).unwrap();
            assert!(store.quarantined_days().is_empty());

            let sealed_path = dir.join("days/2026-10-25.sqlite");
            let hot_path = dir.join("days/2026-10-25.hot.sqlite");
            assert!(
                sealed_path.exists(),
                "step {stop_step}: recovery must produce 2026-10-25.sqlite"
            );
            assert!(
                !hot_path.exists(),
                "step {stop_step}: recovery must remove 2026-10-25.hot.sqlite"
            );

            // Verify journal_mode is delete and _meta.state is sealed on 2026-10-25.sqlite.
            let conn = Connection::open(&sealed_path).unwrap();
            let jmode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(jmode.to_ascii_lowercase(), "delete");
            let state: String = conn
                .query_row("SELECT v FROM _meta WHERE k = 'state'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(state, "sealed");

            let snap = store.catalog_snapshot();
            let d1 = snap.days.get("2026-10-25").unwrap();
            assert_eq!(d1.state, DayFileState::Sealed);
            assert_eq!(d1.rows, 20);

            let d2 = snap.days.get("2026-10-26").unwrap();
            assert_eq!(d2.state, DayFileState::Hot);
            assert_eq!(d2.rows, 10);

            // Query across both sealed day 1 and hot day 2.
            let res = store
                .reader()
                .sql(
                    "SELECT COUNT(*) AS cnt FROM events",
                    Some(TimeWindow::new(day1_ts - NS_PER_HOUR, day2_ts + NS_PER_HOUR)),
                )
                .unwrap();
            assert_eq!(
                res.rows[0].columns.get("cnt"),
                Some(&SqlValue::Integer(30))
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn startup_recovery_cleans_tmp_trash_and_quarantines_corrupt_hot_file() {
    let dir = temp_test_dir("recovery-corrupt");
    let day1_ts = 1_792_886_400 * NS_PER_SECOND; // 2026-10-25
    let day2_ts = day1_ts + NS_PER_DAY; // 2026-10-26
    let clock = Arc::new(ManualClock::new(day1_ts));

    fs::create_dir_all(dir.join("days")).unwrap();
    fs::create_dir_all(dir.join("trash")).unwrap();
    fs::write(dir.join("days/leftover.sqlz.tmp"), b"temp").unwrap();
    fs::write(dir.join("trash/old.sqlite"), b"trash").unwrap();

    // Create a corrupt hot file for yesterday (2026-10-25.hot.sqlite).
    let corrupt_hot = dir.join("days/2026-10-25.hot.sqlite");
    {
        let conn = Connection::open(&corrupt_hot).unwrap();
        conn.execute_batch(
            "CREATE TABLE events (id INTEGER PRIMARY KEY, data TEXT);
             INSERT INTO events (data) VALUES ('hello');",
        )
        .unwrap();
    }
    // Overwrite bytes in the middle of the SQLite file to corrupt its B-tree page.
    {
        let mut f = OpenOptions::new().write(true).open(&corrupt_hot).unwrap();
        f.seek(SeekFrom::Start(100)).unwrap();
        f.write_all(&[0xff; 512]).unwrap();
        f.sync_all().unwrap();
    }

    clock.set_ns(day2_ts);
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();

    // Verify *.tmp and trash/ were cleaned.
    assert!(!dir.join("days/leftover.sqlz.tmp").exists());
    assert!(fs::read_dir(dir.join("trash")).unwrap().next().is_none());

    // Verify the corrupt file was quarantined to 2026-10-25.corrupt.sqlite and reported.
    assert_eq!(store.quarantined_days(), &["2026-10-25".to_owned()]);
    assert!(dir.join("days/2026-10-25.corrupt.sqlite").exists());
    assert!(!dir.join("days/2026-10-25.hot.sqlite").exists());

    // Verify locking prevents a second Store::open on the same root.
    let second = Store::open_with_clock(StoreConfig::new(&dir), clock.clone());
    assert!(matches!(second, Err(StoreError::AlreadyLocked(_))));

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn merge_rule_matches_in_memory_oracle_with_late_events_and_early_stop() {
    let dir = temp_test_dir("merge-oracle");
    let base_day_ts = 1_792_454_400 * NS_PER_SECOND; // 2026-10-20T00:00:00Z
    let clock = Arc::new(ManualClock::new(base_day_ts + NS_PER_HOUR));

    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();

    // Generate 5 arrival days of events where 5% of events arrive a day late (timestamp in previous day),
    // and compare every query primitive against an in-memory oracle.
    let mut oracle: Vec<Event> = Vec::new();
    let mut rng_state: u32 = 12345;
    let mut next_rnd = || -> f64 {
        rng_state = rng_state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (rng_state as f64) / 4_294_967_296.0
    };

    let shared_trace = [0x42u8; 16];

    for day_idx in 0..5i64 {
        let day_start = base_day_ts + day_idx * NS_PER_DAY;
        clock.set_ns(day_start + 12 * NS_PER_HOUR);

        let mut batch = Vec::new();
        for i in 0..200i64 {
            let mut ts = day_start + (i * 300) * NS_PER_SECOND;
            // 5% of timestamps are a day late (engine.md §8).
            if day_idx > 0 && next_rnd() < 0.05 {
                ts -= NS_PER_DAY;
            }

            let svc = if i % 3 == 0 { "api" } else { "worker" };
            let err = next_rnd() < 0.15;
            let sess = format!("s{}", i % 15);
            let req = format!("req-{}", i % 20);
            let is_trace = i % 25 == 0;
            let has_needle = i % 40 == 0;

            let mut ev = sample_event(ts, svc, EventKind::Log, err);
            ev.ingest_ts = Some(clock.now_ns() + i);
            ev.session_id = Some(sess);
            ev.request_id = Some(req);
            ev.trace_id = Some(if is_trace {
                shared_trace
            } else {
                [(day_idx as u8) + 1; 16]
            });
            ev.span_id = Some([(day_idx as u8), (i as u8), 1, 2, 3, 4, 5, 6]);
            ev.body = Some(if has_needle {
                format!("frame render display link stalled at idx={i} day={day_idx}")
            } else {
                format!("normal log idx={i} day={day_idx}")
            });
            ev.attrs = Some(format!(r#"{{"env":"prod","shard":"s{}"}}"#, i % 7));

            oracle.push(ev.clone());
            batch.push(ev);
        }

        writer.submit(batch).unwrap().wait().unwrap();
        writer.wait_for_seals().unwrap();
    }

    let full_win = TimeWindow::new(base_day_ts - NS_PER_DAY, base_day_ts + 6 * NS_PER_DAY);

    // 1. Verify recent_errors("api", k=15) against oracle (including late events!).
    let mut expected_api_errs: Vec<i64> = oracle
        .iter()
        .filter(|e| e.service == "api" && e.compute_err())
        .map(|e| e.ts)
        .collect();
    expected_api_errs.sort_by(|a, b| b.cmp(a));
    expected_api_errs.truncate(15);

    let got_api_errs = reader.recent_errors("api", 15, Some(full_win)).unwrap();
    let got_ts: Vec<i64> = got_api_errs.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_ts, expected_api_errs);
    // Because 15 errors are found in the newest 1-2 days and older days have max_ts < kth_ts,
    // early stop must avoid searching all 5 files!
    assert!(
        got_api_errs.meta.files_searched < 5,
        "expected early stop to search < 5 files, searched {}",
        got_api_errs.meta.files_searched
    );

    // 2. Verify by_session_id("s3", k=20) against oracle.
    let mut expected_sess: Vec<i64> = oracle
        .iter()
        .filter(|e| e.session_id.as_deref() == Some("s3"))
        .map(|e| e.ts)
        .collect();
    expected_sess.sort_by(|a, b| b.cmp(a));
    expected_sess.truncate(20);

    let got_sess = reader.by_session_id("s3", 20, Some(full_win)).unwrap();
    let got_sess_ts: Vec<i64> = got_sess.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_sess_ts, expected_sess);

    // 3. Verify by_request_id("req-7", k=20) against oracle.
    let mut expected_req: Vec<i64> = oracle
        .iter()
        .filter(|e| e.request_id.as_deref() == Some("req-7"))
        .map(|e| e.ts)
        .collect();
    expected_req.sort_by(|a, b| b.cmp(a));
    expected_req.truncate(20);

    let got_req = reader.by_request_id("req-7", 20, Some(full_win)).unwrap();
    let got_req_ts: Vec<i64> = got_req.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_req_ts, expected_req);

    // 4. Verify by_trace_id(shared_trace) against oracle (ascending ts).
    let mut expected_trace: Vec<i64> = oracle
        .iter()
        .filter(|e| e.trace_id == Some(shared_trace))
        .map(|e| e.ts)
        .collect();
    expected_trace.sort();

    let got_trace = reader.by_trace_id(&shared_trace, Some(full_win)).unwrap();
    let got_trace_ts: Vec<i64> = got_trace.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_trace_ts, expected_trace);

    // 5. Verify around_timestamp against oracle.
    let center = base_day_ts + 2 * NS_PER_DAY + 3600 * NS_PER_SECOND;
    let half = 1500 * NS_PER_SECOND;
    let mut expected_around: Vec<i64> = oracle
        .iter()
        .filter(|e| e.service == "api" && e.ts >= center - half && e.ts <= center + half)
        .map(|e| e.ts)
        .collect();
    expected_around.sort();

    let got_around = reader
        .around_timestamp(center, Some(half), Some("api"), 100)
        .unwrap();
    let got_around_ts: Vec<i64> = got_around.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_around_ts, expected_around);

    // 6. Verify body_substring("display link") against oracle.
    let expected_sub_count = oracle
        .iter()
        .filter(|e| e.body.as_deref().unwrap_or("").contains("display link"))
        .count();
    let got_sub = reader
        .body_substring("display link", None, 100, Some(full_win))
        .unwrap();
    assert_eq!(got_sub.rows.len(), expected_sub_count);

    // 7. Verify by_attr("shard", "s2") against oracle.
    let mut expected_attr: Vec<i64> = oracle
        .iter()
        .filter(|e| e.attrs.as_deref().unwrap_or("").contains(r#""shard":"s2""#))
        .map(|e| e.ts)
        .collect();
    expected_attr.sort_by(|a, b| b.cmp(a));
    expected_attr.truncate(30);

    let got_attr = reader.by_attr("shard", "s2", 30, Some(full_win)).unwrap();
    let got_attr_ts: Vec<i64> = got_attr.rows.iter().map(|r| r.ts).collect();
    assert_eq!(got_attr_ts, expected_attr);

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ad_hoc_sql_sandbox_authorizer_and_read_only_cli_while_writer_runs() {
    let dir = temp_test_dir("sql-and-cli");
    let day1_ts = 1_792_800_000 * NS_PER_SECOND; // 2026-10-24
    let day2_ts = day1_ts + NS_PER_DAY; // 2026-10-25
    let clock = Arc::new(ManualClock::new(day1_ts));

    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();

    // Write day 1 and roll to day 2 so day 1 is sealed and day 2 is hot.
    let d1_rows: Vec<Event> = (0..15)
        .map(|i| sample_event(day1_ts + i * 1000, "api", EventKind::Span, i % 3 == 0))
        .collect();
    writer.submit(d1_rows).unwrap().wait().unwrap();

    clock.set_ns(day2_ts);
    let d2_rows: Vec<Event> = (0..25)
        .map(|i| sample_event(day2_ts + i * 1000, "worker", EventKind::Log, i % 5 == 0))
        .collect();
    writer.submit(d2_rows).unwrap().wait().unwrap();
    writer.wait_for_seals().unwrap();

    // Open a read-only CLI Reader while the daemon Store/Writer is still running!
    let cli_clock = Arc::new(ManualClock::new(day2_ts + 5 * NS_PER_SECOND));
    let cli_reader = Reader::open_read_only_with_clock(&dir, cli_clock).unwrap();

    // Verify staleness reporting from max_ingest_ts.
    let staleness = cli_reader.staleness_ns().unwrap();
    assert_eq!(staleness, 5 * NS_PER_SECOND);

    // Query across both the sealed day 1 (`immutable=1`) and hot day 2 (`mode=ro`) via CLI reader.
    let win = TimeWindow::new(day1_ts - NS_PER_HOUR, day2_ts + NS_PER_HOUR);
    let sql_res = cli_reader
        .sql(
            "SELECT service, COUNT(*) AS cnt FROM events GROUP BY service ORDER BY service",
            Some(win),
        )
        .unwrap();
    assert_eq!(sql_res.rows.len(), 2);
    assert_eq!(
        sql_res.rows[0].columns.get("service"),
        Some(&SqlValue::Text("api".to_owned()))
    );
    assert_eq!(
        sql_res.rows[0].columns.get("cnt"),
        Some(&SqlValue::Integer(15))
    );
    assert_eq!(
        sql_res.rows[1].columns.get("service"),
        Some(&SqlValue::Text("worker".to_owned()))
    );
    assert_eq!(
        sql_res.rows[1].columns.get("cnt"),
        Some(&SqlValue::Integer(25))
    );

    // Verify authorizer blocks writes, ATTACH, PRAGMA, DDL, unlisted functions, and multi-statement injection.
    for forbidden in [
        "DELETE FROM d0.events",
        "DELETE FROM events",
        "INSERT INTO d0.events (ts, ingest_ts, kind, service) VALUES (1, 1, 'log', 'api')",
        "ATTACH DATABASE ':memory:' AS evil",
        "PRAGMA journal_mode = DELETE",
        "CREATE TABLE evil (x INT)",
        "SELECT randomblob(16)",
        "SELECT 1; DROP TABLE events",
    ] {
        let err = reader.sql(forbidden, Some(win)).unwrap_err();
        assert!(
            matches!(err, StoreError::UnauthorizedSql(_)),
            "expected UnauthorizedSql for `{forbidden}`, got {err:?}"
        );
    }

    // Verify progress-handler deadline aborts a runaway recursive CTE.
    let fast_timeout_reader = reader.with_deadline(Duration::from_millis(25));
    let deadline_err = fast_timeout_reader
        .sql(
            "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i < 100000000) SELECT COUNT(*) FROM r",
            Some(win),
        )
        .unwrap_err();
    assert!(
        matches!(deadline_err, StoreError::QueryDeadlineExceeded),
        "expected QueryDeadlineExceeded, got {deadline_err:?}"
    );

    drop(cli_reader);
    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn blocker_1_shutdown_drains_queued_batches_and_injected_commit_failure_acks_err() {
    let dir = temp_test_dir("blocker1-acks");
    let t0 = 1_792_886_400 * NS_PER_SECOND;
    let clock = Arc::new(ManualClock::new(t0));

    let mut cfg = StoreConfig::new(&dir);
    cfg.group_commit_interval = Duration::from_millis(50);
    cfg.group_commit_max_rows = 16;

    let store = Store::open_with_clock(cfg.clone(), clock.clone()).unwrap();
    let writer = store.writer();

    // 1. Inject a group commit failure: every pending batch in that group must receive Err,
    // queue bytes must return to 0, and subsequent batches must still commit normally.
    cfg.fail_next_commits
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let fail_ack1 = writer
        .submit(vec![sample_event(t0 + 1, "api", EventKind::Log, false)])
        .unwrap();
    let fail_ack2 = writer
        .submit(vec![sample_event(t0 + 2, "api", EventKind::Log, false)])
        .unwrap();
    assert!(fail_ack1.wait().is_err());
    assert!(fail_ack2.wait().is_err());
    assert_eq!(
        writer
            .metrics()
            .queued_bytes
            .load(std::sync::atomic::Ordering::Acquire),
        0
    );

    // Subsequent batch succeeds after the injected failure.
    let ok_ack = writer
        .submit(vec![sample_event(t0 + 3, "api", EventKind::Log, false)])
        .unwrap();
    assert_eq!(ok_ack.wait().unwrap().rows_committed, 1);

    // 2. Enqueue more batches than `group_commit_max_rows` (16) and immediately drop `Store`:
    // Shutdown must drain the entire channel and resolve every Ack without hanging.
    let mut shutdown_acks = Vec::new();
    for i in 0..40 {
        let ev = sample_event(t0 + 100 + i, "api", EventKind::Span, false);
        shutdown_acks.push(writer.submit(vec![ev]).unwrap());
    }
    drop(store);

    for ack in shutdown_acks {
        let committed = ack.wait().expect("queued batch must commit before shutdown");
        assert_eq!(committed.rows_committed, 1);
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn blocker_2_external_reader_holding_wal_never_quarantines_and_corrupt_preserves_wal() {
    let dir = temp_test_dir("blocker2-recovery-busy");
    let day1_ts = 1_792_886_400 * NS_PER_SECOND; // 2026-10-25
    let day2_ts = day1_ts + NS_PER_DAY; // 2026-10-26
    let clock = Arc::new(ManualClock::new(day1_ts));

    // 1. Write 10 rows on day 1 and stop seal at step 1 so `2026-10-25.hot.sqlite` remains hot on disk.
    {
        let mut cfg = StoreConfig::new(&dir);
        cfg.seal_stop_after_step = Some(1);
        let store = Store::open_with_clock(cfg, clock.clone()).unwrap();
        let writer = store.writer();
        let rows: Vec<Event> = (0..10)
            .map(|i| sample_event(day1_ts + i * 1000, "api", EventKind::Span, true))
            .collect();
        writer.submit(rows).unwrap().wait().unwrap();
    }

    let hot_day1 = dir.join("days/2026-10-25.hot.sqlite");
    assert!(hot_day1.exists());

    // 2. Hold an external read transaction open on `2026-10-25.hot.sqlite` so `journal_mode = DELETE`
    // fails with `SQLITE_BUSY` during startup recovery on day 2.
    let ext_conn = Connection::open_with_flags(
        &hot_day1,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    ext_conn.execute_batch("BEGIN;").unwrap();
    let cnt: i64 = ext_conn
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 10);

    clock.set_ns(day2_ts);
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();

    // Must NOT quarantine a healthy file that merely returned SQLITE_BUSY!
    assert!(
        store.quarantined_days().is_empty(),
        "healthy BUSY file must not be quarantined: {:?}",
        store.quarantined_days()
    );
    assert!(hot_day1.exists(), "hot file must remain in place while BUSY");
    assert!(!dir.join("days/2026-10-25.corrupt.sqlite").exists());

    // And the rows in yesterday's unsealed hot file must remain queryable!
    let errs = store
        .reader()
        .recent_errors(
            "api",
            20,
            Some(TimeWindow::new(day1_ts - NS_PER_HOUR, day2_ts)),
        )
        .unwrap();
    assert_eq!(errs.rows.len(), 10);

    // 3. Release the external reader: background sealer retry must now finish sealing 2026-10-25.sqlite!
    drop(ext_conn);
    store.writer().wait_for_seals().unwrap();

    assert!(
        dir.join("days/2026-10-25.sqlite").exists(),
        "background retry sealer must seal 2026-10-25.sqlite once external reader closes"
    );
    assert!(!hot_day1.exists());
    assert!(
        !store
            .catalog_snapshot()
            .seal_errors
            .contains_key("2026-10-25"),
        "seal_errors must be cleared after retry succeeds"
    );
    drop(store);

    // 4. Verify that when a genuinely corrupt hot file has `-wal` and `-shm` sidecars,
    // quarantine renames them to `.corrupt.sqlite-wal` and `.corrupt.sqlite-shm` instead of unlinking.
    let corrupt_hot = dir.join("days/2026-10-24.hot.sqlite");
    let corrupt_wal = dir.join("days/2026-10-24.hot.sqlite-wal");
    let corrupt_shm = dir.join("days/2026-10-24.hot.sqlite-shm");
    fs::write(&corrupt_hot, b"not a valid sqlite file header at all").unwrap();
    fs::write(&corrupt_wal, b"precious wal frames").unwrap();
    fs::write(&corrupt_shm, b"shm bytes").unwrap();

    let store2 = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    assert_eq!(store2.quarantined_days(), vec!["2026-10-24".to_owned()]);
    assert!(dir.join("days/2026-10-24.corrupt.sqlite").exists());
    assert!(
        dir.join("days/2026-10-24.corrupt.sqlite-wal").exists(),
        "quarantine must preserve -wal sidecar"
    );
    assert!(
        dir.join("days/2026-10-24.corrupt.sqlite-shm").exists(),
        "quarantine must preserve -shm sidecar"
    );
    drop(store2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn blocker_3_backwards_clock_step_never_overwrites_sealed_day_or_deletes_hot_file() {
    let dir = temp_test_dir("blocker3-clock-step");
    let day1_ts = 1_792_886_400 * NS_PER_SECOND + 12 * NS_PER_HOUR; // 2026-10-25 12:00 UTC
    let day2_ts = day1_ts + NS_PER_DAY; // 2026-10-26 12:00 UTC
    let clock = Arc::new(ManualClock::new(day1_ts));

    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();

    // 1. Write 15 rows on day 1 (2026-10-25).
    let d1_rows: Vec<Event> = (0..15)
        .map(|i| sample_event(day1_ts + i * 1000, "api", EventKind::Span, true))
        .collect();
    writer.submit(d1_rows).unwrap().wait().unwrap();

    // 2. Advance clock to day 2 (2026-10-26), write 10 rows, and wait for day 1 to seal.
    clock.set_ns(day2_ts);
    let d2_rows: Vec<Event> = (0..10)
        .map(|i| sample_event(day2_ts + i * 1000, "api", EventKind::Span, true))
        .collect();
    writer.submit(d2_rows).unwrap().wait().unwrap();
    writer.wait_for_seals().unwrap();
    assert!(dir.join("days/2026-10-25.sqlite").exists());

    // 3. Step clock BACKWARDS to day 1 (2026-10-25) and write 5 more rows, then step forward again.
    clock.set_ns(day1_ts + 50_000);
    let backward_rows: Vec<Event> = (0..5)
        .map(|i| sample_event(day1_ts + 50_000 + i * 1000, "api", EventKind::Span, true))
        .collect();
    let ack = writer.submit(backward_rows).unwrap().wait().unwrap();
    // Forward-only roll keeps the active hot day at 2026-10-26 instead of reopening 2026-10-25!
    assert_eq!(ack.day, "2026-10-26");

    clock.set_ns(day2_ts + 100_000);
    writer.flush().unwrap();
    writer.wait_for_seals().unwrap();

    // Verify all 30 rows (15 sealed in 2026-10-25.sqlite + 15 in 2026-10-26.hot.sqlite) exist!
    let win = TimeWindow::new(day1_ts - NS_PER_HOUR, day2_ts + NS_PER_HOUR);
    let errs = store.reader().recent_errors("api", 100, Some(win)).unwrap();
    assert_eq!(errs.rows.len(), 30);
    drop(store);

    // 4. Verify startup recovery never deletes `D.hot.sqlite` if `D.sqlite` already exists on disk:
    // both files are kept in the catalog and `conflicting_days` records the conflict.
    let extra_hot_path = dir.join("days/2026-10-25.hot.sqlite");
    {
        let conn = Connection::open(&extra_hot_path).unwrap();
        conn.execute_batch(&motel_store::schema::base_ddl(true, false))
            .unwrap();
        motel_store::schema::init_meta_defaults(
            &conn,
            "local",
            "2026-10-25",
            "hot",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO events (ts, ingest_ts, kind, service, err, src, body)
             VALUES (?1, ?2, 'log', 'api', 1, 0, 'extra-hot-row')",
            rusqlite::params![day1_ts + 999_000, day1_ts + 999_000],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO _meta (k, v) VALUES ('min_ts', ?1), ('max_ts', ?1), ('min_ingest_ts', ?1), ('max_ingest_ts', ?1), ('rows', 1)",
            rusqlite::params![day1_ts + 999_000],
        )
        .unwrap();
    }

    let store2 = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    assert!(
        extra_hot_path.exists(),
        "startup recovery must not delete hot file when sealed file already exists"
    );
    assert!(dir.join("days/2026-10-25.sqlite").exists());
    let snap2 = store2.catalog_snapshot();
    assert!(snap2.conflicting_days.contains(&"2026-10-25".to_owned()));

    // All 31 rows across 2026-10-25.sqlite (15), 2026-10-25.hot.sqlite (1), and 2026-10-26.hot.sqlite (15) are returned!
    let errs2 = store2.reader().recent_errors("api", 100, Some(win)).unwrap();
    assert_eq!(errs2.rows.len(), 31);

    drop(store2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn should_fixes_isolation_oversized_blocking_strict_jsonb_limits_and_uri_encoding() {
    // Use a directory name containing `?` and `#` and spaces to test RFC 3986 URI percent-encoding (Nit 1).
    let base_dir = temp_test_dir("should-fixes");
    let dir = base_dir.join("dir with spaces #hash ?query %pct");
    fs::create_dir_all(&dir).unwrap();

    let t0 = 1_792_886_400 * NS_PER_SECOND;
    let clock = Arc::new(ManualClock::new(t0));

    let mut cfg = StoreConfig::new(&dir);
    cfg.direct_jsonb = true;
    cfg.group_commit_interval = Duration::from_millis(50);
    cfg.queue_byte_budget = 1024; // Tiny 1 KiB budget to test oversized `submit_blocking` (Should-fix 11).

    let store = Store::open_with_clock(cfg.clone(), clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();

    // 1. Should-fix 11: `submit_blocking` admits a single batch larger than `queue_byte_budget` when queue is empty.
    let mut big_ev = sample_event(t0, "api", EventKind::Log, true);
    big_ev.body = Some("B".repeat(4096));
    // Also test Should-fix 13: caller-supplied `ingest_ts` is ignored and stamped with writer `now_ns` (`t0`).
    big_ev.ingest_ts = Some(42);
    let ack = writer.submit_blocking(vec![big_ev], Vec::new()).unwrap();
    let committed = ack.wait().unwrap();
    assert_eq!(committed.ingest_ts, t0);

    let got = reader.recent_errors("api", 10, None).unwrap();
    assert_eq!(got.rows.len(), 1);
    assert_eq!(
        got.rows[0].ingest_ts, t0,
        "writer must stamp its own clock now_ns as ingest_ts"
    );

    // 2. Should-fix 8: Group commit isolation — one batch with malformed `attrs` must not fail a sibling batch,
    // and an `evidence.sqlite` failure must not fail a hot-only batch in the same group.
    let mut bad_attr_ev = sample_event(t0 + 20, "api", EventKind::Log, true);
    bad_attr_ev.attrs = Some(r#"{"bad": 01}"#.to_owned()); // leading zero invalid in RFC 8259
    let good_ev = sample_event(t0 + 21, "api", EventKind::Log, true);

    let bad_ack = writer.submit(vec![bad_attr_ev]).unwrap();
    let good_ack = writer.submit(vec![good_ev]).unwrap();
    assert!(bad_ack.wait().is_err());
    assert!(good_ack.wait().is_ok());

    // Inject an evidence commit failure while submitting a hot-only batch and an evidence batch together.
    cfg.fail_next_evidence_commits
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let hot_only_ack = writer
        .submit(vec![sample_event(t0 + 30, "api", EventKind::Span, false)])
        .unwrap();
    let ev_only_ack = writer
        .submit(vec![sample_event(t0 + 31, "app", EventKind::Crash, true)])
        .unwrap();
    assert!(
        hot_only_ack.wait().is_ok(),
        "hot-only batch must succeed even if evidence.sqlite fails"
    );
    assert!(
        ev_only_ack.wait().is_err(),
        "evidence batch must report failure when evidence commit fails"
    );

    // 3. Should-fix 12: Direct JSONB encoder strictness (RFC 8259 numbers, escapes, trailing bytes, depth > 128).
    for invalid_json in [
        r#"{"a": 1} trailing"#,
        r#"{"a": 01}"#,
        r#"{"a": 1.}"#,
        r#"{"a": 1e}"#,
        r#"{"a": --1}"#,
        r#"{"a": "\x41"}"#,
        r#"{"a": "\uD800"}"#,
        &format!("{}{}{}", "[".repeat(130), "1", "]".repeat(130)),
    ] {
        assert!(
            motel_store::jsonb::encode_json_str_to_jsonb(invalid_json).is_none(),
            "expected strict JSONB encoder to reject `{invalid_json}`"
        );
    }

    // 4. Should-fix 9: Reader connection limits (`SQLITE_LIMIT_LENGTH = 1 MiB`) block huge allocations in `sql()`.
    let big_blob_res = reader.sql("SELECT zeroblob(2000000)", None);
    assert!(
        big_blob_res.is_err(),
        "expected SQLITE_LIMIT_LENGTH (1 MiB) to reject 2 MB zeroblob"
    );

    drop(store);
    let _ = fs::remove_dir_all(&base_dir);
}

#[test]
fn test_wal_hard_cap_under_stalled_reader() {
    let dir = temp_test_dir("wal_hard_cap_stalled_reader");
    let day0_ns = 1_777_075_200_000_000_000i64; // 2026-04-25T00:00:00Z
    let clock = Arc::new(ManualClock::new(day0_ns));

    let mut cfg = StoreConfig::new(&dir);
    // Set a 1.5 MiB hard WAL cap and a 64 KiB queue budget so queue backpressure engages
    // quickly while the writer pauses queue draining at the WAL hard trigger (~1.125 MiB).
    cfg.wal_hard_cap_bytes = 1_536 * 1024;
    cfg.queue_byte_budget = 64 * 1024;
    cfg.group_commit_interval = Duration::from_millis(5);
    cfg.group_commit_max_rows = 256;
    cfg.query_deadline = Duration::from_millis(350);

    let store = Store::open_with_clock(cfg, clock).expect("open store");
    let writer = store.writer().clone();
    let reader = Arc::new(store.reader());

    // Seed an initial batch so the hot file and `events` table have rows.
    let seed: Vec<Event> = (0..64)
        .map(|i| sample_event(day0_ns + i * 1_000, "svc-wal", EventKind::Span, false))
        .collect();
    writer.submit(seed).unwrap().wait().unwrap();

    // Push enough batches (~1.2 MiB of WAL frames across B-tree indexes) to cross the hard trigger.
    let make_fat_batch = |batch_idx: i64| -> Vec<Event> {
        (0..120)
            .map(|i| {
                let seq = batch_idx * 1_000 + i;
                let mut ev = sample_event(day0_ns + seq * 1_000, "svc-wal", EventKind::Span, false);
                ev.body = Some("x".repeat(220));
                ev.attrs = Some(format!(
                    r#"{{"http.route":"/api/v1/items/{seq}","seq":{seq},"pad":"{}"}}"#,
                    "p".repeat(120)
                ));
                ev
            })
            .collect()
    };

    // Start a stalled reader on a background thread that holds a WAL snapshot on the hot file
    // until the progress-handler deadline (350 ms) aborts it.
    let reader_bg = Arc::clone(&reader);
    let (reader_started_tx, reader_started_rx) = std::sync::mpsc::channel();
    let reader_handle = std::thread::spawn(move || {
        let _ = reader_started_tx.send(());
        reader_bg.sql(
            "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < 200000000)
             SELECT sum(x) + (SELECT count(*) FROM events) FROM r",
            None,
        )
    });
    reader_started_rx.recv().unwrap();
    std::thread::sleep(Duration::from_millis(30));

    // Enqueue batches until the WAL reaches the hard trigger and the writer pauses queue drain
    // while waiting for the stalled reader's snapshot to be released by its deadline.
    let mut acks = Vec::new();
    let mut saw_queue_full = false;
    for b in 1..=18 {
        let batch = make_fat_batch(b);
        match writer.submit(batch.clone()) {
            Ok(ack) => {
                // Wait on the first few batches so the WAL builds up while the reader holds the snapshot;
                // once near the cap, enqueue without waiting to observe queue backpressure (429).
                if b <= 8 {
                    ack.wait().expect("commit batch");
                } else {
                    acks.push(ack);
                }
            }
            Err(SubmitError::QueueFull { .. }) => {
                saw_queue_full = true;
                // Tailer path blocks until the stalled reader's deadline releases the snapshot
                // and the writer truncates the WAL and resumes draining.
                let ack = writer
                    .submit_blocking(batch, Vec::new())
                    .expect("blocking enqueue after WAL reset");
                acks.push(ack);
                break;
            }
            Err(e) => panic!("unexpected enqueue error: {e}"),
        }
    }

    for ack in acks {
        ack.wait().expect("commit queued batch after reader deadline");
    }

    let reader_res = reader_handle.join().expect("reader thread join");
    assert!(
        matches!(reader_res, Err(StoreError::QueryDeadlineExceeded)),
        "expected stalled reader to abort with QueryDeadlineExceeded, got {reader_res:?}"
    );
    assert!(
        saw_queue_full,
        "expected queue backpressure (QueueFull / 429) while writer paused queue drain at WAL cap"
    );

    writer.flush().expect("flush writer");

    // Verify that the hard WAL cap (1.5 MiB) was never exceeded even though 12+ batches (~1.8 MiB
    // of total WAL frames) were written while the stalled reader held its snapshot, and that after
    // the reader's deadline released the snapshot, the WAL truncated and only holds the post-reset tail.
    let peak_wal = writer.metrics().wal_peak_bytes.load(std::sync::atomic::Ordering::Relaxed);
    assert!(
        peak_wal <= 1_536 * 1024,
        "expected peak WAL bytes ({peak_wal}) <= hard cap (1.5 MiB)"
    );
    let wal_path = dir.join("days").join("2026-04-25.hot.sqlite-wal");
    let final_wal_bytes = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
    assert!(
        final_wal_bytes < 512 * 1024,
        "expected final WAL bytes ({final_wal_bytes}) to reflect post-reset tail (< 512 KiB)"
    );

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_direct_jsonb_default_and_fallback() {
    let dir = temp_test_dir("direct_jsonb_default");
    let day0_ns = 1_777_075_200_000_000_000i64;
    let clock = Arc::new(ManualClock::new(day0_ns));
    let cfg = StoreConfig::new(&dir);
    assert!(cfg.direct_jsonb, "direct_jsonb should default to true");

    let store = Store::open_with_clock(cfg, clock).expect("open store");
    let writer = store.writer();
    let reader = store.reader();

    // 1. Normal event with direct_jsonb=true.
    let mut ev1 = sample_event(day0_ns + 1_000, "svc-jsonb", EventKind::Log, false);
    ev1.attrs = Some(r#"{"http.route":"/v1/fast","status":200}"#.to_owned());

    // 2. Valid JSON with nesting depth 140 (> 128 fast-path limit in `encode_json_str_to_jsonb_buf`,
    // which exercises `sqlite_jsonb_fallback` to SQLite's `jsonb(?)`).
    let mut ev2 = sample_event(day0_ns + 2_000, "svc-jsonb", EventKind::Log, false);
    ev2.attrs = Some(format!(
        r#"{{"deep":{}"ok"{},"http.route":"/v1/deep"}}"#,
        "[".repeat(140),
        "]".repeat(140)
    ));

    writer
        .submit(vec![ev1, ev2])
        .unwrap()
        .wait()
        .expect("valid batches should commit via direct_jsonb + fallback");

    let mut bad_ev = sample_event(day0_ns + 3_000, "svc-jsonb", EventKind::Log, false);
    bad_ev.attrs = Some(r#"{"unterminated": 123"#.to_owned());
    let bad_res = writer.submit(vec![bad_ev]).unwrap().wait();
    assert!(
        bad_res.is_err(),
        "invalid JSON must still be rejected when direct_jsonb=true"
    );

    let hits = reader
        .by_attr(
            "http.route",
            "/v1/fast",
            10,
            Some(TimeWindow::new(day0_ns, day0_ns + 10_000)),
        )
        .unwrap();
    assert_eq!(hits.rows.len(), 1);

    let deep_hits = reader
        .by_attr(
            "http.route",
            "/v1/deep",
            10,
            Some(TimeWindow::new(day0_ns, day0_ns + 10_000)),
        )
        .unwrap();
    assert_eq!(deep_hits.rows.len(), 1);

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_idle_shrink_releases_writer_cache_and_allocator_pages() {
    let dir = temp_test_dir("idle_shrink_memory");
    let day0_ns = 1_777_075_200_000_000_000i64;
    let clock = Arc::new(ManualClock::new(day0_ns));
    let mut cfg = StoreConfig::new(&dir);
    // Keep checkpointer from auto-truncating so the writer connection retains its dirty/clean
    // page cache until `shrink_memory()` runs.
    cfg.wal_hard_cap_bytes = 64 * 1024 * 1024;
    cfg.group_commit_interval = Duration::from_millis(5);

    let store = Store::open_with_clock(cfg, clock).expect("open store");
    let writer = store.writer();

    for b in 0..10i64 {
        let batch: Vec<Event> = (0..500)
            .map(|i| {
                let seq = b * 500 + i;
                let mut ev =
                    sample_event(day0_ns + seq * 1_000, "svc-shrink", EventKind::Span, false);
                ev.body = Some("y".repeat(300));
                ev.attrs = Some(format!(
                    r#"{{"http.route":"/api/v1/shrink/{seq}","seq":{seq},"pad":"{}"}}"#,
                    "z".repeat(160)
                ));
                ev
            })
            .collect();
        writer.submit(batch).unwrap().wait().unwrap();
    }
    writer.flush().unwrap();

    let used_before = motel_store::sqlite_memory_used_bytes();
    assert!(
        used_before > 1_000_000,
        "expected writer page cache to hold > 1 MB before idle shrink, got {used_before}"
    );

    writer.shrink_memory().expect("shrink_memory");

    let used_after = motel_store::sqlite_memory_used_bytes();
    assert!(
        used_after < 512 * 1024,
        "expected SQLite memory used after idle shrink ({used_after}) < 512 KiB (was {used_before})"
    );

    let wal_path = dir.join("days").join("2026-04-25.hot.sqlite-wal");
    let wal_bytes = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
    assert_eq!(wal_bytes, 0, "expected idle shrink to truncate WAL to 0 bytes");

    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn query_file_and_sql_table_reader_primitives() {
    let dir = temp_test_dir("query-file");
    let t0 = 1_792_800_000 * NS_PER_SECOND;
    let clock = Arc::new(ManualClock::new(t0));
    let store = Store::open_with_clock(StoreConfig::new(&dir), clock.clone()).unwrap();
    let writer = store.writer();
    let reader = store.reader();
    let rows: Vec<Event> = (0..6)
        .map(|i| sample_event(t0 + i * 1000, "api", EventKind::Log, i % 2 == 0))
        .collect();
    writer.submit(rows).unwrap().wait().unwrap();

    assert_eq!(reader.now_ns(), t0);
    assert!(!reader.is_direct());

    let snap = reader.catalog_snapshot();
    let entry = snap.days.values().next().unwrap().clone();
    let deadline = std::time::Instant::now() + reader.default_deadline();
    let errs = reader
        .query_file(&entry, deadline, |conn| {
            let sql = format!("SELECT {} FROM events WHERE err = 1 ORDER BY id", motel_store::EVENT_COLUMNS);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], |r| motel_store::event_row_from_sql(r, &entry.day))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(errs.len(), 3);
    assert_eq!(errs[0].id, format!("{}:1", entry.day));
    assert_eq!(errs[0].attrs.as_deref(), Some(r#"{"http.route":"/users","http.status_code":200}"#));

    let table = reader
        .sql_table(
            "SELECT service AS z, count(*) AS a FROM events GROUP BY 1",
            Some(TimeWindow::new(t0 - NS_PER_HOUR, t0 + NS_PER_HOUR)),
        )
        .unwrap();
    assert_eq!(table.columns, vec!["z".to_owned(), "a".to_owned()]);
    assert_eq!(
        table.rows,
        vec![vec![SqlValue::Text("api".to_owned()), SqlValue::Integer(6)]]
    );

    let cli = Reader::open_read_only_with_clock(&dir, clock).unwrap();
    assert!(cli.is_direct());
    drop(cli);
    drop(store);
    let _ = fs::remove_dir_all(&dir);
}
