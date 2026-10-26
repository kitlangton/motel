//! `motel why [service]`: ranked findings (`docs/agent-api.md` §1).
//!
//! Ranking: crashes, then NEW error groups, then failed runs, then recurring error groups.
//! Within a rank: crashes and runs newest first, groups by count then recency.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use motel_store::{EventRow, NS_PER_DAY, NS_PER_HOUR};
use serde::Serialize;

use crate::data::{attr, attr_str, Ctx, ErrRow, ErrScan};
use crate::fingerprint::{fingerprint, group_id};
use crate::ids::EventRef;
use crate::render::{
    count, finish, motel_sql, one_line, plural, shell_arg, sql_str, table, LIST_BODY_CHARS,
};
use crate::searched::Searched;
use crate::time::{fmt_dur, fmt_minute, fmt_range, fmt_time, iso};
use crate::{Answer, Query, QueryError};

const BASELINE_BUDGET: Duration = Duration::from_millis(1500);
const BASELINE_DAYS: i64 = 7;

/// Bounds on one window's work.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Caps {
    /// Error rows read before counting stops.
    pub error_rows: usize,
    /// Baseline (7 days before the window) rows read in total, across services.
    pub baseline_rows: usize,
    /// Distinct error groups held; further groups are counted, not listed.
    pub groups: usize,
    /// Crash and failed-run rows read from evidence.
    pub evidence: usize,
}

impl Caps {
    pub const DEFAULT: Caps = Caps {
        error_rows: 200_000,
        baseline_rows: 400_000,
        groups: 5_000,
        evidence: 2_000,
    };
}
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
    /// False when the baseline scan hit its budget: NEW groups were not seen in the part
    /// read, and text marks them `NEW?`.
    pub baseline_complete: bool,
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
    fn new(r: ErrRow) -> Self {
        Self {
            service: r.service,
            kind: r.kind,
            name: r.name,
            count: 1,
            first: r.ts,
            last: r.ts,
            latest: r.ev,
            latest_msg: r.msg,
        }
    }

    fn add(&mut self, r: ErrRow) {
        self.count += 1;
        self.first = self.first.min(r.ts);
        if r.ts > self.last {
            self.last = r.ts;
            self.latest = r.ev;
            self.latest_msg = r.msg;
        }
    }
}

fn fp_of(r: &ErrRow) -> u64 {
    fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg)
}

struct Window {
    /// The first `limit` findings in rank order.
    findings: Vec<Finding>,
    /// Findings before the cut.
    total: usize,
    totals: WhyTotals,
    baseline_complete: bool,
    notes: Vec<String>,
}

pub(crate) fn why(q: &Query, args: &WhyArgs) -> Result<WhyAnswer, QueryError> {
    why_with(q, args, Caps::DEFAULT)
}

pub(crate) fn why_with(q: &Query, args: &WhyArgs, caps: Caps) -> Result<WhyAnswer, QueryError> {
    let ctx = Ctx::new(q);
    let end = args.until.unwrap_or(ctx.now);
    if let Some(since) = args.since {
        if since > end {
            return Err(QueryError::BadTime(format!(
                "--since {} is after --until {}",
                iso(since),
                iso(end)
            )));
        }
    }
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
        baseline_complete: true,
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
    let mut w = None;
    for s in &starts {
        tried += 1;
        start = *s;
        let found = analyze(&ctx, svc, start, end, limit, caps)?;
        let done = !found.findings.is_empty() || ctx.cut_short.get();
        w = Some(found);
        if done {
            break;
        }
    }
    let Some(w) = w else {
        return Err(QueryError::BadTime("no window to search".to_owned()));
    };

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
    answer.baseline_complete = w.baseline_complete;
    answer.totals = w.totals;
    answer.omitted = w.total.saturating_sub(w.findings.len()) as u64;
    answer.findings = w.findings;

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
                motel_sql(&format!(
                    "select kind, name, count(*) n from events where service = '{}' group by 1, 2 order by n desc",
                    sql_str(s)
                )),
                "motel why".to_owned(),
            ],
            None => vec![
                motel_sql("select service, kind, count(*) n from events group by 1, 2 order by n desc"),
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

/// One window. Crashes and failed runs come from the evidence store; only the remaining
/// error kinds are scanned from day files and grouped by fingerprint.
fn analyze(
    ctx: &Ctx<'_>,
    svc: Option<&str>,
    start: i64,
    end: i64,
    limit: usize,
    caps: Caps,
) -> Result<Window, QueryError> {
    let mut notes = Vec::new();

    let (crash_rows, crashes_more) =
        ctx.evidence_errors("crash", start, end, svc, caps.evidence)?;
    let crash_count = crash_rows.len() as u64;
    let mut crashes: HashMap<u64, Agg> = HashMap::new();
    for r in crash_rows {
        match crashes.entry(fp_of(&r)) {
            Entry::Occupied(mut e) => e.get_mut().add(r),
            Entry::Vacant(e) => {
                e.insert(Agg::new(r));
            }
        }
    }
    let (runs, runs_more) = ctx.evidence_errors("run", start, end, svc, caps.evidence)?;
    if crashes_more || runs_more {
        notes.push(format!(
            "more than {} crashes or failed runs; counted the newest",
            count(caps.evidence as u64)
        ));
    }

    let mut groups: HashMap<u64, Agg> = HashMap::new();
    let mut error_events = 0u64;
    let mut ungrouped = 0u64;
    let services = svc.map(|s| vec![s.to_owned()]);
    let scan = ctx.scan_errors(
        &ErrScan {
            start,
            end,
            services: services.as_deref(),
            kind_name: None,
            ordered: true,
            cap: caps.error_rows,
            deadline: ctx.deadline,
        },
        |r| {
            error_events += 1;
            let fp = fp_of(&r);
            let full = groups.len() >= caps.groups;
            match groups.entry(fp) {
                Entry::Occupied(mut e) => e.get_mut().add(r),
                Entry::Vacant(e) if !full => {
                    e.insert(Agg::new(r));
                }
                Entry::Vacant(_) => ungrouped += 1,
            }
            true
        },
    )?;
    if scan.truncated {
        notes.push(format!(
            "counted the newest {} error events only",
            count(scan.rows as u64)
        ));
    }
    if ungrouped > 0 {
        notes.push(format!(
            "more than {} distinct error groups; {} events in further groups are counted but not listed",
            count(caps.groups as u64),
            count(ungrouped)
        ));
    }

    // NEW: fingerprints absent from the 7 days before the window start. One pass over the
    // baseline files (newest first) with one shared row cap, stopping once every group has
    // been seen.
    let mut unseen: HashSet<u64> = groups.keys().copied().collect();
    let mut baseline_complete = true;
    if !unseen.is_empty() {
        let mut names: Vec<String> = groups.values().map(|g| g.service.clone()).collect();
        names.sort_unstable();
        names.dedup();
        let b = ctx.scan_errors(
            &ErrScan {
                start: start - BASELINE_DAYS * NS_PER_DAY,
                end: start - 1,
                services: Some(&names),
                kind_name: None,
                ordered: false,
                cap: caps.baseline_rows,
                deadline: Instant::now() + BASELINE_BUDGET,
            },
            |r| {
                unseen.remove(&fp_of(&r));
                !unseen.is_empty()
            },
        )?;
        baseline_complete = !b.truncated;
    }
    if !baseline_complete && !unseen.is_empty() {
        notes.push(
            "baseline scan stopped early; NEW? groups were not seen in the part read and may be recurring"
                .to_owned(),
        );
    }

    let mut crash_list: Vec<Agg> = crashes.into_values().collect();
    crash_list.sort_by(|a, b| {
        b.last
            .cmp(&a.last)
            .then(a.latest.row_id.cmp(&b.latest.row_id))
    });
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
    let new_groups = group_list.iter().filter(|g| g.0).count();
    let group_count = group_list.len();
    let total = crash_list.len() + group_list.len() + runs.len();

    // Rank order: crashes, NEW groups, failed runs, recurring groups. Only the first
    // `limit` become findings.
    let mut findings: Vec<Finding> = Vec::with_capacity(limit.min(total));
    for c in crash_list.iter().take(limit) {
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
            c,
            one_line(&summary, LIST_BODY_CHARS),
            c.latest.id(),
        ));
    }
    let (new_list, recurring_list) = group_list.split_at(new_groups);
    let group_finding = |(is_new, fp, g): &(bool, u64, Agg)| {
        finding(
            if *is_new {
                FindingKind::New
            } else {
                FindingKind::Recurring
            },
            g,
            group_summary(g),
            group_id(*fp),
        )
    };
    let room = limit.saturating_sub(findings.len());
    findings.extend(new_list.iter().take(room).map(group_finding));
    let room = limit.saturating_sub(findings.len());
    for r in runs.iter().take(room) {
        let summary = match ctx.event(&r.ev)? {
            Some(ev) => {
                let failed =
                    ctx.evidence_count("test", ev.ts, ev.ts + ev.dur.unwrap_or(0), true)?;
                run_summary(&ev, failed)
            }
            None => one_line(r.name.as_deref().unwrap_or("run"), LIST_BODY_CHARS),
        };
        let agg = Agg::new(r.clone());
        findings.push(finding(
            FindingKind::FailedRun,
            &agg,
            summary,
            format!("run:{}", r.ev.row_id),
        ));
    }
    let room = limit.saturating_sub(findings.len());
    findings.extend(recurring_list.iter().take(room).map(group_finding));

    Ok(Window {
        findings,
        total,
        totals: WhyTotals {
            error_events,
            groups: group_count as u64,
            new_groups: new_groups as u64,
            crashes: crash_count,
            failed_runs: runs.len() as u64,
        },
        baseline_complete,
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
                        if f.kind == FindingKind::New && !self.baseline_complete {
                            "NEW?".to_owned()
                        } else {
                            f.kind.label().to_owned()
                        },
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
    use crate::fixture::{seeded, Fixture};

    fn why_caps(f: &Fixture, caps: Caps) -> WhyAnswer {
        why_with(&f.query(), &WhyArgs::default(), caps).unwrap()
    }

    #[test]
    fn crashes_and_failed_runs_survive_the_error_scan_cap() {
        let f = seeded("why-cap-errors");
        let w = why_caps(
            &f,
            Caps {
                error_rows: 2,
                ..Caps::DEFAULT
            },
        );
        assert!(w
            .findings
            .iter()
            .any(|x| x.kind == FindingKind::Crash && x.id == "e:ev.2"));
        assert!(w
            .findings
            .iter()
            .any(|x| x.kind == FindingKind::FailedRun && x.id == "run:3"));
        assert_eq!(w.totals.error_events, 2);
        assert!(w
            .searched
            .notes
            .iter()
            .any(|n| n.contains("newest 2 error events")));
    }

    #[test]
    fn an_incomplete_baseline_marks_new_unconfirmed() {
        let f = seeded("why-cap-baseline");
        let w = why_caps(
            &f,
            Caps {
                baseline_rows: 1,
                ..Caps::DEFAULT
            },
        );
        assert!(!w.baseline_complete);
        let text = w.text();
        assert!(text.contains("NEW?"), "{text}");
        assert!(text.contains("baseline scan stopped early"), "{text}");
        let w = why_caps(&f, Caps::DEFAULT);
        assert!(w.baseline_complete);
        assert!(!w.text().contains("NEW?"));
    }

    #[test]
    fn distinct_groups_are_capped_but_still_counted() {
        let f = seeded("why-cap-groups");
        let w = why_caps(
            &f,
            Caps {
                groups: 2,
                ..Caps::DEFAULT
            },
        );
        assert_eq!(w.totals.groups, 2);
        assert_eq!(w.totals.error_events, 10);
        assert!(w
            .searched
            .notes
            .iter()
            .any(|n| n.contains("more than 2 distinct error groups")));
    }

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
