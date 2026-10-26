mod common;

use std::process::Command;

use common::*;
use motel_query::fingerprint::{fingerprint, group_id};
use motel_query::{Answer, FindingKind, QueryError, ShowView, WhyArgs, WhyEmpty, SHOW_LINE_CAP};

fn why(f: &Fixture, service: Option<&str>, since: Option<i64>) -> motel_query::WhyAnswer {
    f.query()
        .why(&WhyArgs {
            service: service.map(str::to_owned),
            since,
            ..Default::default()
        })
        .unwrap()
}

fn find<'a>(w: &'a motel_query::WhyAnswer, needle: &str) -> &'a motel_query::Finding {
    w.findings
        .iter()
        .find(|f| f.summary.contains(needle))
        .unwrap_or_else(|| panic!("no finding with {needle:?} in {:#?}", w.findings))
}

#[test]
fn why_ranks_crashes_new_failed_runs_then_recurring() {
    let f = seeded("rank");
    let w = why(&f, None, None);
    let kinds: Vec<FindingKind> = w.findings.iter().map(|f| f.kind).collect();
    assert_eq!(
        kinds,
        [
            FindingKind::Crash,
            FindingKind::New,
            FindingKind::New,
            FindingKind::New,
            FindingKind::FailedRun,
            FindingKind::Recurring,
        ]
    );
    // NEW groups: by count, then recency.
    assert!(w.findings[1].summary.contains("TypeError"));
    assert_eq!(w.findings[1].count, 3);
    assert!(w.findings[2].summary.contains("rate limited"));
    // The late-arriving error is counted with its event time.
    let late = find(&w, "disk quota");
    assert_eq!(late.kind, FindingKind::New);
    assert_eq!(late.first, "2026-10-24T19:00:00.000Z");
    // Recurring: 4 hits in the window, 2 more in the baseline.
    let db = find(&w, "db timeout");
    assert_eq!((db.kind, db.count), (FindingKind::Recurring, 4));
    assert_eq!(w.findings[0].id, "e:ev.2");
    assert_eq!(w.findings[4].id, "run:3");
    assert_eq!(w.totals.crashes, 1);
    assert_eq!(w.totals.failed_runs, 1);
    assert_eq!(w.totals.error_events, 10);
    assert_eq!(w.next.len(), 3);
    assert_eq!(w.next[0], "motel show e:ev.2");
}

#[test]
fn new_is_relative_to_since() {
    let f = seeded("since-new");
    let w = why(&f, None, Some(COMMIT));
    assert_eq!(
        w.baseline_since.as_deref(),
        Some("2026-10-18T12:00:00.000Z")
    );
    // First seen at -5h, before the commit: recurring now.
    assert_eq!(find(&w, "rate limited").kind, FindingKind::Recurring);
    assert_eq!(find(&w, "TypeError").kind, FindingKind::New);
    // The -20h late error is outside the window.
    assert!(w.findings.iter().all(|f| !f.summary.contains("disk quota")));
    assert_eq!(find(&w, "db timeout").count, 2);

    // One service only.
    let w = why(&f, Some("worker"), None);
    assert_eq!(w.findings.len(), 1);
    assert_eq!(w.findings[0].kind, FindingKind::Crash);
}

#[test]
fn group_ids_are_stable_and_show_resolves_them() {
    let f = seeded("groups");
    let w = why(&f, None, None);
    let te = find(&w, "TypeError");
    // Same group whatever the line number in the path.
    let expected = group_id(fingerprint(
        "api",
        "span",
        Some("users.load"),
        "TypeError: Cannot read properties of undefined (reading 'name') at /other/path.ts:1:1",
    ));
    assert_eq!(te.id, expected);
    assert_eq!(
        why(&f, None, None).findings[1].id,
        te.id,
        "stable across calls"
    );

    let s = f.query().show(&te.id, false).unwrap();
    let ShowView::Group(g) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!(g.count, 3);
    assert_eq!(g.samples.len(), 3);
    assert_eq!(g.traces.len(), 3);
    assert!(g.traces.contains(&hex(&T1)));
    assert!(g.message.contains("<path>"));

    // The recurring group counts its baseline hits too (14 days).
    let db = find(&w, "db timeout");
    let s = f.query().show(&db.id, false).unwrap();
    let ShowView::Group(g) = &s.view else {
        panic!()
    };
    assert_eq!(g.count, 6);

    let missing = f.query().show("g:00000000", false).unwrap();
    assert!(matches!(missing.view, ShowView::NotFound { .. }));
    assert!(missing.text().contains("motel why"));
}

#[test]
fn why_walks_back_when_the_default_window_is_empty() {
    let f = seeded("walk");
    let w = why(&f, Some("cron"), None);
    assert_eq!(w.findings.len(), 1);
    assert!(w.searched.walked_back);
    assert!(w.text().contains("nothing in the last 24h; widened to 7d"));
    // An explicit --since never walks back.
    let w = why(&f, Some("cron"), Some(NOW - 2 * H));
    assert!(w.findings.is_empty());
    assert!(!w.searched.walked_back);
    assert!(w.next[0].starts_with("motel why cron --since 7d"));
}

#[test]
fn why_empty_states() {
    let f = seeded("empty-states");
    let w = why(&f, Some("apii"), None);
    match &w.empty {
        Some(WhyEmpty::UnknownService { near, services, .. }) => {
            assert_eq!(near, &["api"]);
            assert!(services.contains(&"worker".to_owned()));
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(w.next, ["motel why api", "motel why"]);

    let w = why(&f, Some("batch"), None);
    match &w.empty {
        Some(WhyEmpty::Quiet { last_event, .. }) => {
            assert_eq!(last_event.as_deref(), Some("2026-10-22T15:02:00.000Z"))
        }
        e => panic!("{e:?}"),
    }
    assert!(w
        .text()
        .contains("batch is quiet: last event Oct 22 15:02:00"));

    let e = empty("empty-store");
    let w = e.query().why(&WhyArgs::default()).unwrap();
    assert!(matches!(w.empty, Some(WhyEmpty::StoreEmpty)));
    assert!(w.text().contains("the store is empty"));
}

#[test]
fn why_limit_reports_the_rest() {
    let f = seeded("limit");
    let w = f
        .query()
        .why(&WhyArgs {
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(w.findings.len(), 2);
    assert_eq!(w.omitted, 4);
    assert!(w.text().contains("+4 more: motel why --limit 6"));
}

#[test]
fn show_trace_interleaves_logs_and_reads_late_spans() {
    let f = seeded("trace");
    let s = f.query().show(&hex(&T1), false).unwrap();
    let ShowView::Trace(t) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!((t.spans, t.errors), (4, 1));
    let names: Vec<(usize, &str)> = t
        .items
        .iter()
        .map(|i| {
            (
                i.depth,
                i.event
                    .name
                    .as_deref()
                    .or(i.event.body.as_deref())
                    .unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            (0, "GET /users/:id"),
            (1, "GET /users/8812 start"),
            (1, "auth.check"),
            (1, "db.query"),
            (1, "users.load"),
            (2, "user cache miss for 8812"),
        ]
    );
    let text = s.text();
    assert!(text.contains("users.load  ERR TypeError"));
    assert!(text.contains("auth.check [auth]"));

    // A child span stamped yesterday that arrived today.
    let s = f.query().show(&hex(&T_LATE), false).unwrap();
    let ShowView::Trace(t) = &s.view else {
        panic!()
    };
    assert_eq!(t.spans, 2);
    assert_eq!(t.items[1].event.service, "worker");
    assert_eq!(t.items[1].depth, 1);
    assert!(!s.next.is_empty());
}

#[test]
fn show_span_focuses_its_trace() {
    let f = seeded("span");
    let s = f.query().show(&hex(&T1), false).unwrap();
    let ShowView::Trace(t) = &s.view else {
        panic!()
    };
    let load = t
        .items
        .iter()
        .find(|i| i.event.name.as_deref() == Some("users.load"))
        .unwrap();
    let span_id = load.event.span_id.clone().unwrap();

    let s = f.query().show(&span_id, false).unwrap();
    let ShowView::Span { span, trace } = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!(span.span_id.as_deref(), Some(span_id.as_str()));
    assert_eq!(trace.trace_id, hex(&T1));
    let text = s.text();
    assert!(text
        .lines()
        .any(|l| l.starts_with('>') && l.contains("users.load")));
    assert_eq!(s.next[0], format!("motel show {}", load.event.id));
}

#[test]
fn show_crash_has_frames_breadcrumbs_and_after() {
    let f = seeded("crash");
    let s = f.query().show("e:ev.2", false).unwrap();
    let ShowView::Event(e) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!(e.event.kind, "crash");
    assert_eq!(e.pid, Some(4242));
    assert_eq!(e.frames.len(), 6);
    assert_eq!(e.frames[3], "3: worker::queue::Queue::pop");
    let crumbs: Vec<&str> = e
        .breadcrumbs
        .iter()
        .filter_map(|b| b.body.as_deref())
        .collect();
    assert_eq!(
        crumbs,
        [
            "job 17 started",
            "queue depth 3 above soft limit",
            "popping job 18"
        ]
    );
    assert_eq!(e.context.len(), 1);
    assert_eq!(
        e.context[0].body.as_deref(),
        Some("worker restarted (pid 4300)")
    );
}

#[test]
fn show_plain_event_has_context_and_trace() {
    let f = seeded("event");
    let s = f.query().show(&hex(&T1), false).unwrap();
    let ShowView::Trace(t) = &s.view else {
        panic!()
    };
    let id = t
        .items
        .iter()
        .find(|i| i.event.err)
        .unwrap()
        .event
        .id
        .clone();
    assert!(id.starts_with("e:20261025."));

    let s = f.query().show(&id, false).unwrap();
    let ShowView::Event(e) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert!(e.trace.is_some());
    assert!(e.group.as_deref().is_some_and(|g| g.starts_with("g:")));
    // ±30 s of api: the trace's own api rows, not the auth span.
    assert!(e.context.iter().all(|c| c.service == "api"));
    assert!(e.context.iter().any(|c| c.id == id));
    assert_eq!(s.next[0], format!("motel show {}", hex(&T1)));

    let missing = f.query().show("e:20261025.999999", false).unwrap();
    assert!(matches!(missing.view, ShowView::NotFound { .. }));
}

#[test]
fn show_run_lists_failed_tests_and_slow_spans() {
    let f = seeded("run");
    for id in ["run:last", "run:3"] {
        let s = f.query().show(id, false).unwrap();
        let ShowView::Run(r) = &s.view else {
            panic!("{:?}", s.view)
        };
        assert_eq!(r.command, "cargo test -p api");
        assert_eq!(r.exit_code, Some(serde_json::json!(101)));
        let failed: Vec<&str> = r
            .failed_tests
            .iter()
            .filter_map(|t| t.name.as_deref())
            .collect();
        assert_eq!(
            failed,
            [
                "users::create_rejects_dupes",
                "users::get_missing_returns_404"
            ]
        );
        assert_eq!(r.slowest_spans[0].name, "db.query");
        assert_eq!(r.slowest_spans[0].dur_ms, 2400.0);
        assert_eq!(r.slowest_spans[0].p50_ms, Some(300.0));
        assert!(r.slowest_spans.iter().all(|s| s.name != "test suite"));
        assert_eq!(
            r.slowest_spans
                .iter()
                .find(|s| s.name == "fixtures.load")
                .unwrap()
                .p50_ms,
            None
        );
        assert!(s.text().contains("8.0x"));
    }
    // The older passing run.
    let s = f.query().show("run:1", false).unwrap();
    let ShowView::Run(r) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert!(r.failed_tests.is_empty());
    assert!(s
        .next
        .iter()
        .any(|n| n.starts_with("motel why --since 2026-10-23T15:00:00")));
    assert!(matches!(
        f.query().show("run:99", false).unwrap().view,
        ShowView::NotFound { .. }
    ));
}

#[test]
fn show_session_and_request_timelines() {
    let f = seeded("timeline");
    let s = f.query().show("ses_demo1", false).unwrap();
    let ShowView::Timeline(t) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!(t.key, "session_id");
    assert_eq!(t.events, 18);
    assert_eq!(t.traces.len(), 3);
    assert!(t.traces.iter().all(|t| t.errors.len() == 1));

    let s = f.query().show("req-7f3a2", false).unwrap();
    let ShowView::Timeline(t) = &s.view else {
        panic!("{:?}", s.view)
    };
    assert_eq!(t.key, "request_id");
    assert_eq!(t.traces[0].trace_id.as_deref(), Some(hex(&T1).as_str()));

    let s = f.query().show("nope", false).unwrap();
    assert!(matches!(s.view, ShowView::NotFound { .. }));
    let text = s.text();
    assert!(text.starts_with("no session or request matched \"nope\" in the last 14 days."));
    assert!(text.contains("searched: last 14d"));
    assert!(text.contains("host devbox"));
}

#[test]
fn show_is_capped_at_200_lines_unless_full() {
    let f = seeded("cap");
    let s = f.query().show(&hex(&T_BIG), false).unwrap();
    let text = s.text();
    assert_eq!(text.lines().count(), SHOW_LINE_CAP);
    assert!(text.contains(&format!("more lines: motel show {} --full", hex(&T_BIG))));
    let full = f.query().show(&hex(&T_BIG), true).unwrap().text();
    assert!(full.lines().count() > 260);
    assert!(!full.contains("--full"));
}

#[test]
fn since_forms() {
    let f = seeded("since");
    let q = f.query();
    assert_eq!(q.resolve_since("2h", None).unwrap(), NOW - 2 * H);
    assert_eq!(q.resolve_since("1h30m", None).unwrap(), NOW - 90 * M);
    assert_eq!(q.resolve_since("14:02", None).unwrap(), NOW - 58 * M);
    // Later than now today means yesterday.
    assert_eq!(q.resolve_since("16:00", None).unwrap(), NOW - 23 * H);
    assert_eq!(
        q.resolve_since("2026-10-25T10:00:00Z", None).unwrap(),
        NOW - 5 * H
    );
    assert_eq!(
        q.resolve_since("2026-10-25T12:00:00+02:00", None).unwrap(),
        NOW - 5 * H
    );
    assert_eq!(q.resolve_since("run:last", None).unwrap(), NOW - 90 * M);
    assert!(matches!(
        q.resolve_since("HEAD~1", None),
        Err(QueryError::BadTime(_))
    ));
    assert!(matches!(
        q.resolve_since("--exec=x", None),
        Err(QueryError::BadTime(_))
    ));

    // A git ref, resolved to its commit time in the caller's repo.
    let repo = temp_dir("git");
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(&repo)
            .env("GIT_COMMITTER_DATE", "2026-10-25T12:00:00Z")
            .env("GIT_AUTHOR_DATE", "2026-10-25T11:00:00Z")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "change"]);
    assert_eq!(q.resolve_since("HEAD", Some(&repo)).unwrap(), COMMIT);
    assert!(matches!(
        q.resolve_since("no-such-branch", Some(&repo)),
        Err(QueryError::BadTime(_))
    ));
    let _ = std::fs::remove_dir_all(&repo);

    let e = empty("since-empty");
    assert!(matches!(
        e.query().resolve_since("run:last", None),
        Err(QueryError::BadTime(_))
    ));
}

#[test]
fn sql_and_schema() {
    let f = seeded("sql");
    let q = f.query();
    let a = q
        .sql(
            "select service, count(*) n from events where err group by 1 order by n desc",
            None,
        )
        .unwrap();
    assert_eq!(a.columns, ["service", "n"]);
    assert_eq!(a.rows[0], [serde_json::json!("api"), serde_json::json!(10)]);
    assert!(a.text().contains("searched: last 24h"));

    let a = q
        .sql(
            "select attr(attrs, 'http.route') route, count(*) n from events where kind = 'span' and attr(attrs, 'http.route') is not null group by 1",
            Some(motel_store::TimeWindow::new(NOW - 3 * H, NOW)),
        )
        .unwrap();
    assert_eq!(
        a.rows,
        [[serde_json::json!("/users/:id"), serde_json::json!(3)]]
    );

    for bad in [
        "select nope from events",
        "delete from events",
        "select 1; select 2",
    ] {
        match q.sql(bad, None) {
            Err(QueryError::Sql { schema, .. }) => {
                assert!(schema.contains("attr(attrs, 'http.route')"))
            }
            other => panic!("{bad}: {:?}", other.map(|a| a.text())),
        }
    }

    let s = q.schema().unwrap();
    let names: Vec<&str> = s.services.iter().map(|s| s.service.as_str()).collect();
    assert_eq!(names, ["api", "worker", "cargo", "auth", "batch", "cron"]);
    assert_eq!(s.examples.len(), 5);
    assert_eq!(s.columns.len(), 20);
}

#[test]
fn every_answer_says_what_it_searched_and_what_next() {
    let f = seeded("contract");
    let q = f.query();
    let mut answers: Vec<Box<dyn Answer>> = vec![
        Box::new(why(&f, None, None)),
        Box::new(why(&f, Some("batch"), None)),
        Box::new(why(&f, Some("apii"), None)),
        Box::new(q.schema().unwrap()),
        Box::new(q.sql("select 1 x", None).unwrap()),
    ];
    for id in [
        hex(&T1),
        hex(&T_LATE),
        "e:ev.2".into(),
        "run:last".into(),
        "ses_demo1".into(),
        "nope".into(),
    ] {
        answers.push(Box::new(q.show(&id, false).unwrap()));
    }
    for a in &answers {
        let text = a.text();
        assert!(
            text.contains("\nsearched: ") || text.starts_with("searched: "),
            "{text}"
        );
        assert!(
            text.contains("host devbox · via daemon · last write 2m ago"),
            "{text}"
        );
        assert!(!text.contains('\x1b'), "no ANSI");
        let json = a.json();
        let next = json["next"].as_array().unwrap();
        assert!((1..=3).contains(&next.len()), "{text}");
        assert!(json["searched"]["host"] == "devbox");
    }
}
