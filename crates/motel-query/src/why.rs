//! `motel why [service]`: ranked findings (api.md §1).
//!
//! Ranking: crashes, then NEW error groups, then failed runs, then recurring error groups.
//! Within a rank: crashes and runs newest first, groups by count then recency.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use motel_store::{EventRow, NS_PER_DAY, NS_PER_HOUR};
use serde::Serialize;

use crate::data::{attr, attr_str, is_group_kind, Ctx, ErrRow};
use crate::fingerprint::{fingerprint, group_id};
use crate::ids::EventRef;
use crate::render::{count, finish, one_line, plural, shell_arg, sql_str, table, LIST_BODY_CHARS};
use crate::searched::Searched;
use crate::time::{fmt_dur, fmt_minute, fmt_range, fmt_time, iso};
use crate::{Answer, Query, QueryError};

/// Error rows read per window before counting stops.
const ERROR_SCAN_CAP: usize = 200_000;
/// Baseline (7 days before the window) rows read per service.
const BASELINE_SCAN_CAP: usize = 200_000;
const BASELINE_DAYS: i64 = 7;
/// Default-window walk-back: 24 h, then 3, 7 and 14 days.
const WALK_BACK: [i64; 4] = [
    24 * NS_PER_HOUR,
    3 * NS_PER_DAY,
    7 * NS_PER_DAY,
    14 * NS_PER_DAY,
];

#[derive(Debug, Clone)]
pub struct WhyArgs {
    pub service: Option<String>,
    /// Window start in Unix ns; `None` = 24 h, walking back to 14 days when empty.
    pub since: Option<i64>,
    /// Window end in Unix ns; `None` = now.
    pub until: Option<i64>,
    /// Findings to return (default 10).
    pub limit: usize,
}

impl Default for WhyArgs {
    fn default() -> Self {
        Self {
            service: None,
            since: None,
            until: None,
            limit: 10,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    Crash,
    New,
    FailedRun,
    Recurring,
}

impl FindingKind {
    fn label(self) -> &'static str {
        match self {
            FindingKind::Crash => "CRASH",
            FindingKind::New => "NEW",
            FindingKind::FailedRun => "FAILED RUN",
            FindingKind::Recurring => "RECURRING",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub kind: FindingKind,
    pub service: String,
    pub count: u64,
    pub first: String,
    pub last: String,
    pub summary: String,
    /// Pass to `motel show`.
    pub id: String,
    #[serde(skip)]
    first_ns: i64,
    #[serde(skip)]
    last_ns: i64,
}

/// Why an answer has no findings.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum WhyEmpty {
    /// Nothing has ever been recorded on this host.
    StoreEmpty,
    /// No events from this service at all; `near` are similar names seen in 14 days.
    UnknownService {
        service: String,
        near: Vec<String>,
        services: Vec<String>,
    },
    /// Events exist, but no errors, crashes or failed runs in the window.
    Quiet {
        last_event: Option<String>,
        last_service: Option<String>,
        #[serde(skip)]
        last_event_ns: Option<i64>,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WhyTotals {
    pub error_events: u64,
    pub groups: u64,
    pub new_groups: u64,
    pub crashes: u64,
    pub failed_runs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhyAnswer {
    pub service: Option<String>,
    pub searched: Searched,
    /// The NEW baseline: the 7 days before the window start.
    pub baseline_since: Option<String>,
    pub findings: Vec<Finding>,
    /// Findings beyond `limit`.
    pub omitted: u64,
    pub totals: WhyTotals,
    pub empty: Option<WhyEmpty>,
    pub next: Vec<String>,
    #[serde(skip)]
    explicit_since: bool,
    #[serde(skip)]
    baseline_start_ns: i64,
}

struct Agg {
    service: String,
    kind: String,
    name: Option<String>,
    count: u64,
    first: i64,
    last: i64,
    latest: EventRef,
    latest_msg: String,
}

impl Agg {
    fn new(r: &ErrRow) -> Self {
        Self {
            service: r.service.clone(),
            kind: r.kind.clone(),
            name: r.name.clone(),
            count: 0,
            first: r.ts,
            last: r.ts,
            latest: r.ev.clone(),
            latest_msg: r.msg.clone(),
        }
    }

    fn add(&mut self, r: &ErrRow) {
        self.count += 1;
        self.first = self.first.min(r.ts);
        if r.ts > self.last || self.count == 1 {
            self.last = r.ts;
            self.latest = r.ev.clone();
            self.latest_msg = r.msg.clone();
        }
    }
}

struct Window {
    findings: Vec<Finding>,
    totals: WhyTotals,
    notes: Vec<String>,
}

pub(crate) fn why(q: &Query, args: &WhyArgs) -> Result<WhyAnswer, QueryError> {
    let ctx = Ctx::new(q);
    let end = args.until.unwrap_or(ctx.now);
    let limit = if args.limit == 0 {
        10
    } else {
        args.limit.min(200)
    };
    let svc = args
        .service
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut answer = WhyAnswer {
        service: svc.map(str::to_owned),
        searched: ctx.searched(end - WALK_BACK[0], end),
        baseline_since: None,
        findings: Vec::new(),
        omitted: 0,
        totals: WhyTotals::default(),
        empty: None,
        next: Vec::new(),
        explicit_since: args.since.is_some(),
        baseline_start_ns: 0,
    };

    if ctx.store_is_empty() {
        answer.empty = Some(WhyEmpty::StoreEmpty);
        answer.next = vec!["motel status".to_owned(), "motel schema".to_owned()];
        return Ok(answer);
    }

    if let Some(s) = svc {
        if ctx.service_last_ts(s)?.is_none() {
            let seen = ctx.services(ctx.now - 14 * NS_PER_DAY, ctx.now)?;
            let names: Vec<String> = seen.iter().map(|(n, _, _)| n.clone()).collect();
            let near = nearest(s, &names);
            answer.next = near
                .iter()
                .take(2)
                .map(|n| format!("motel why {}", shell_arg(n)))
                .chain(std::iter::once("motel why".to_owned()))
                .collect();
            answer.searched = ctx.searched(ctx.now - 14 * NS_PER_DAY, ctx.now);
            answer.empty = Some(WhyEmpty::UnknownService {
                service: s.to_owned(),
                near,
                services: names,
            });
            return Ok(answer);
        }
    }

    let starts: Vec<i64> = match args.since {
        Some(s) => vec![s],
        None => WALK_BACK.iter().map(|w| end - w).collect(),
    };
    let mut tried = 0;
    let mut start = starts[0];
    let mut result = None;
    for s in &starts {
        tried += 1;
        start = *s;
        let w = analyze(&ctx, svc, start, end, limit)?;
        if !w.findings.is_empty() {
            result = Some(w);
            break;
        }
        result = Some(w);
    }
    let w = result.expect("at least one window");

    answer.searched = ctx.searched(start, end);
    answer.searched.walked_back = tried > 1;
    if tried > 1 {
        let first_span = crate::time::fmt_span(end - starts[0]);
        answer.searched.notes.push(if w.findings.is_empty() {
            format!(
                "nothing in the last {first_span}; walked back to {}",
                crate::time::fmt_span(end - start)
            )
        } else {
            format!(
                "nothing in the last {first_span}; widened to {}",
                crate::time::fmt_span(end - start)
            )
        });
    }
    answer.searched.notes.extend(w.notes);
    answer.baseline_start_ns = start - BASELINE_DAYS * NS_PER_DAY;
    answer.baseline_since = Some(iso(answer.baseline_start_ns));
    answer.totals = w.totals;

    let total = w.findings.len();
    answer.findings = w.findings.into_iter().take(limit).collect();
    answer.omitted = total.saturating_sub(answer.findings.len()) as u64;

    if answer.findings.is_empty() {
        let (last_ns, last_service) = match svc {
            Some(s) => (ctx.service_last_ts(s)?, Some(s.to_owned())),
            None => match ctx.last_event()? {
                Some((ts, s)) => (Some(ts), Some(s)),
                None => (None, None),
            },
        };
        answer.empty = Some(WhyEmpty::Quiet {
            last_event: last_ns.map(iso),
            last_service,
            last_event_ns: last_ns,
        });
        answer.next = match svc {
            Some(s) => vec![
                format!(
                    "motel sql \"select kind, name, count(*) n from events where service = '{}' group by 1, 2 order by n desc\"",
                    sql_str(s)
                ),
                "motel why".to_owned(),
            ],
            None => vec![
                "motel sql \"select service, kind, count(*) n from events group by 1, 2 order by n desc\"".to_owned(),
                "motel schema".to_owned(),
            ],
        };
        if args.since.is_some() {
            let svc_arg = svc
                .map(|s| format!(" {}", shell_arg(s)))
                .unwrap_or_default();
            answer
                .next
                .insert(0, format!("motel why{svc_arg} --since 7d"));
        }
    } else {
        answer.next = answer
            .findings
            .iter()
            .take(3)
            .map(|f| format!("motel show {}", f.id))
            .collect();
    }
    Ok(answer)
}

fn analyze(
    ctx: &Ctx<'_>,
    svc: Option<&str>,
    start: i64,
    end: i64,
    limit: usize,
) -> Result<Window, QueryError> {
    let mut groups: HashMap<u64, Agg> = HashMap::new();
    let mut crashes: HashMap<u64, Agg> = HashMap::new();
    let mut runs: Vec<ErrRow> = Vec::new();
    let mut error_events = 0u64;
    let mut notes = Vec::new();

    let scan = ctx.scan_errors(start, end, svc, None, ERROR_SCAN_CAP, ctx.deadline, |r| {
        match r.kind.as_str() {
            "run" => runs.push(r),
            "crash" => {
                let fp = fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg);
                crashes.entry(fp).or_insert_with(|| Agg::new(&r)).add(&r);
            }
            k if is_group_kind(k) => {
                error_events += 1;
                let fp = fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg);
                groups.entry(fp).or_insert_with(|| Agg::new(&r)).add(&r);
            }
            _ => {}
        }
        true
    })?;
    if scan.truncated {
        notes.push(format!(
            "counted the newest {} error events only",
            count(scan.rows as u64)
        ));
    }

    // NEW: fingerprints absent from the 7 days before the window start.
    let baseline_start = start - BASELINE_DAYS * NS_PER_DAY;
    let mut unseen: HashSet<u64> = groups.keys().copied().collect();
    let mut by_service: HashMap<String, HashSet<u64>> = HashMap::new();
    for (fp, g) in &groups {
        by_service.entry(g.service.clone()).or_default().insert(*fp);
    }
    let baseline_deadline = Instant::now() + Duration::from_millis(1500);
    let mut services: Vec<_> = by_service.into_iter().collect();
    services.sort_by(|a, b| a.0.cmp(&b.0));
    let mut partial = false;
    for (service, mut pending) in services {
        let s = ctx.scan_errors(
            baseline_start,
            start - 1,
            Some(&service),
            None,
            BASELINE_SCAN_CAP,
            baseline_deadline,
            |r| {
                if is_group_kind(&r.kind) {
                    let fp = fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg);
                    if pending.remove(&fp) {
                        unseen.remove(&fp);
                    }
                }
                !pending.is_empty()
            },
        )?;
        partial |= s.truncated;
    }
    if partial {
        notes.push("baseline scan hit its budget; some NEW marks may be recurring".to_owned());
    }

    let mut findings: Vec<Finding> = Vec::new();

    let mut crash_list: Vec<Agg> = crashes.into_values().collect();
    crash_list.sort_by_key(|c| std::cmp::Reverse(c.last));
    let crash_count = crash_list.iter().map(|c| c.count).sum();
    for c in crash_list {
        let first_line = c
            .latest_msg
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let summary = match c.name.as_deref() {
            Some(n) if !first_line.contains(n) => format!("{n}: {first_line}"),
            _ => first_line.to_owned(),
        };
        findings.push(finding(
            FindingKind::Crash,
            &c,
            one_line(&summary, LIST_BODY_CHARS),
            c.latest.id(),
        ));
    }

    let mut group_list: Vec<(bool, u64, Agg)> = groups
        .into_iter()
        .map(|(fp, g)| (unseen.contains(&fp), fp, g))
        .collect();
    group_list.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.2.count.cmp(&a.2.count))
            .then(b.2.last.cmp(&a.2.last))
            .then(a.1.cmp(&b.1))
    });
    let new_groups = group_list.iter().filter(|g| g.0).count() as u64;
    let group_count = group_list.len() as u64;
    let mut recurring = Vec::new();
    for (is_new, fp, g) in group_list {
        let summary = group_summary(&g);
        let f = finding(
            if is_new {
                FindingKind::New
            } else {
                FindingKind::Recurring
            },
            &g,
            summary,
            group_id(fp),
        );
        if is_new {
            findings.push(f);
        } else {
            recurring.push(f);
        }
    }

    runs.sort_by_key(|r| std::cmp::Reverse(r.ts));
    let failed_runs = runs.len() as u64;
    // Only the runs that can make the cut need their details.
    let room = limit.saturating_sub(findings.len());
    for (i, r) in runs.iter().enumerate() {
        let summary = match if i < room { ctx.event(&r.ev)? } else { None } {
            Some(ev) => {
                let end = ev.ts + ev.dur.unwrap_or(0);
                let failed = ctx.evidence_rows("test", ev.ts, end, true, 1000)?.len();
                run_summary(&ev, failed)
            }
            None => one_line(r.name.as_deref().unwrap_or("run"), LIST_BODY_CHARS),
        };
        let mut agg = Agg::new(r);
        agg.add(r);
        findings.push(finding(
            FindingKind::FailedRun,
            &agg,
            summary,
            format!("run:{}", r.ev.row_id),
        ));
    }
    findings.extend(recurring);

    Ok(Window {
        findings,
        totals: WhyTotals {
            error_events,
            groups: group_count,
            new_groups,
            crashes: crash_count,
            failed_runs,
        },
        notes,
    })
}

fn finding(kind: FindingKind, g: &Agg, summary: String, id: String) -> Finding {
    Finding {
        kind,
        service: g.service.clone(),
        count: g.count,
        first: iso(g.first),
        last: iso(g.last),
        summary,
        id,
        first_ns: g.first,
        last_ns: g.last,
    }
}

fn group_summary(g: &Agg) -> String {
    let head = match g.name.as_deref() {
        Some(n) if !n.is_empty() && n != "log" => format!("{} {n}", g.kind),
        _ => g.kind.clone(),
    };
    let msg = if g.latest_msg.trim().is_empty() {
        "(no message)".to_owned()
    } else {
        g.latest_msg.clone()
    };
    one_line(&format!("{head}: {msg}"), LIST_BODY_CHARS)
}

pub(crate) fn run_summary(ev: &EventRow, failed_tests: usize) -> String {
    let cmd = attr_str(ev, "run.command")
        .or_else(|| ev.name.clone())
        .unwrap_or_else(|| "run".to_owned());
    let mut parts = Vec::new();
    if let Some(code) = attr(ev, "exit_code").or_else(|| attr(ev, "process.exit_code")) {
        parts.push(format!("exit {code}"));
    } else if let Some(st) = &ev.status {
        parts.push(st.clone());
    }
    if failed_tests > 0 {
        parts.push(plural(failed_tests as u64, "test failed", "tests failed"));
    }
    if let Some(d) = ev.dur {
        parts.push(fmt_dur(d));
    }
    one_line(&format!("{cmd} ({})", parts.join(", ")), LIST_BODY_CHARS)
}

/// Names within a small edit distance, or sharing a prefix or substring, closest first.
fn nearest(target: &str, names: &[String]) -> Vec<String> {
    let t = target.to_lowercase();
    let mut scored: Vec<(usize, &String)> = names
        .iter()
        .filter_map(|n| {
            let l = n.to_lowercase();
            let d = levenshtein(&t, &l);
            let close = d <= (t.len().max(3) / 3).max(2);
            let related =
                l.contains(&t) || t.contains(&l) || (t.len() >= 2 && l.starts_with(&t[..2]));
            (close || related).then_some((d, n))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(b.1)));
    scored.into_iter().take(3).map(|(_, n)| n.clone()).collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

impl Answer for WhyAnswer {
    fn text(&self) -> String {
        let s = &self.searched;
        let (now, tz) = (s.now_ns, s.tz);
        let who = match &self.service {
            Some(svc) => svc.clone(),
            None => "all services".to_owned(),
        };
        let mut out = String::new();
        match &self.empty {
            Some(WhyEmpty::StoreEmpty) => {
                out.push_str("why: no events recorded on this host yet; the store is empty.\n");
            }
            Some(WhyEmpty::UnknownService {
                service,
                near,
                services,
            }) => {
                out.push_str(&format!(
                    "why {service}: no events from a service named {service:?}.\n"
                ));
                if !near.is_empty() {
                    out.push_str(&format!("did you mean: {}\n", near.join(", ")));
                }
                if services.is_empty() {
                    out.push_str("no services sent events in the last 14 days.\n");
                } else {
                    let shown: Vec<&str> = services.iter().take(12).map(String::as_str).collect();
                    let more = services.len().saturating_sub(shown.len());
                    out.push_str(&format!(
                        "services seen in 14 days: {}{}\n",
                        shown.join(", "),
                        if more > 0 {
                            format!(" (+{more} more)")
                        } else {
                            String::new()
                        }
                    ));
                }
            }
            Some(WhyEmpty::Quiet {
                last_service,
                last_event_ns,
                ..
            }) => {
                let window = if self.explicit_since {
                    format!("since {}", fmt_minute(s.start_ns, now, tz))
                } else {
                    format!(
                        "in the last {}",
                        crate::time::fmt_span(s.end_ns - s.start_ns)
                    )
                };
                out.push_str(&format!(
                    "why {who}: no errors, crashes or failed runs {window}.\n"
                ));
                match (last_event_ns, last_service, &self.service) {
                    (Some(ts), _, Some(svc)) => out.push_str(&format!(
                        "{svc} is quiet: last event {} ({} ago).\n",
                        fmt_time(*ts, now, tz),
                        crate::time::fmt_age(now - ts)
                    )),
                    (Some(ts), Some(last_svc), None) => out.push_str(&format!(
                        "last event {} ({} ago) from {last_svc}.\n",
                        fmt_time(*ts, now, tz),
                        crate::time::fmt_age(now - ts)
                    )),
                    _ => {}
                }
            }
            None => {
                let t = &self.totals;
                let mut parts = Vec::new();
                if t.crashes > 0 {
                    parts.push(plural(t.crashes, "crash", "crashes"));
                }
                parts.push(format!(
                    "{} in {} ({} new)",
                    plural(t.error_events, "error", "errors"),
                    plural(t.groups, "group", "groups"),
                    count(t.new_groups)
                ));
                if t.failed_runs > 0 {
                    parts.push(plural(t.failed_runs, "failed run", "failed runs"));
                }
                out.push_str(&format!("why {who} · {}\n", parts.join(", ")));
                let mut rows = vec![vec![
                    "#".to_owned(),
                    "finding".to_owned(),
                    "service".to_owned(),
                    "count".to_owned(),
                    "when".to_owned(),
                    "id".to_owned(),
                    "summary".to_owned(),
                ]];
                for (i, f) in self.findings.iter().enumerate() {
                    rows.push(vec![
                        (i + 1).to_string(),
                        f.kind.label().to_owned(),
                        f.service.clone(),
                        count(f.count),
                        fmt_range(f.first_ns, f.last_ns, now, tz),
                        f.id.clone(),
                        f.summary.clone(),
                    ]);
                }
                for line in table(&rows, &[true, false, false, true]) {
                    out.push_str(&line);
                    out.push('\n');
                }
                if self.omitted > 0 {
                    let svc_arg = self
                        .service
                        .as_deref()
                        .map(|s| format!(" {}", shell_arg(s)))
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "+{} more: motel why{svc_arg} --limit {}\n",
                        count(self.omitted),
                        self.findings.len() as u64 + self.omitted
                    ));
                }
                if self.findings.iter().any(|f| f.kind == FindingKind::New) {
                    out.push_str(&format!(
                        "NEW = not seen in the 7 days before {}\n",
                        fmt_minute(s.start_ns, now, tz)
                    ));
                }
            }
        }
        finish(out, &s.line(), &self.next)
    }

    fn json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_names() {
        let names: Vec<String> = ["hex", "api", "worker", "hexd"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(nearest("hxe", &names), vec!["hex", "hexd"]);
        assert_eq!(nearest("work", &names), vec!["worker"]);
        assert!(nearest("zzzzzz", &names).is_empty());
    }
}
