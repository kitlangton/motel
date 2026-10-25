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
