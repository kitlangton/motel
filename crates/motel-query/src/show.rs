//! `motel show <id>`: one id, the view picked from its shape (`docs/agent-api.md` §2).

use std::collections::{HashMap, HashSet};

use motel_store::{EventKind, EventRow, NS_PER_DAY, NS_PER_MINUTE, NS_PER_SECOND};
use serde::Serialize;

use crate::data::{attr, attr_str, event_group_id, event_message, Ctx, ErrRow, ErrScan};
use crate::fingerprint::{fingerprint, normalize};
use crate::ids::{classify, event_id, hex, EventRef, ShowId};

const NS_PER_MILLI: i64 = 1_000_000;
use crate::render::{
    count, finish, motel_sql, one_line, plural, severity_name, shell_arg, table, LIST_BODY_CHARS,
};
use crate::searched::Searched;
use crate::time::{fmt_dur, fmt_range, fmt_time, fmt_time_ms, iso};
use crate::why::run_summary;
use crate::{Answer, Query, QueryError};

/// Lines a `show` prints unless `--full` (`docs/agent-api.md` §7).
pub const SHOW_LINE_CAP: usize = 200;
/// Lines of the trace tree inside an event view.
const EVENT_TRACE_LINES: usize = 40;
const SESSION_LIMIT: usize = 1000;
/// Events listed on each side of an event in its context.
const CONTEXT_SIDE: usize = 30;

#[derive(Debug, Clone, Serialize)]
pub struct ShowAnswer {
    pub id: String,
    pub searched: Searched,
    #[serde(flatten)]
    pub view: ShowView,
    pub next: Vec<String>,
    #[serde(skip)]
    lines: Vec<String>,
    #[serde(skip)]
    full: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "view", rename_all = "snake_case")]
pub enum ShowView {
    Trace(Box<TraceView>),
    Span {
        span: Box<EventJson>,
        trace: Box<TraceView>,
    },
    Event(Box<EventView>),
    Group(GroupView),
    Run(Box<RunView>),
    Timeline(TimelineView),
    NotFound {
        searched_for: Vec<String>,
    },
}

/// One event, as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct EventJson {
    pub id: String,
    pub time: String,
    pub kind: String,
    pub service: String,
    pub name: Option<String>,
    pub severity: Option<String>,
    pub status: Option<String>,
    pub err: bool,
    pub dur_ms: Option<f64>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub parent_id: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub artifact: Option<String>,
    pub body: Option<String>,
    /// The stored JSON text, embedded as-is when serialized; text rendering never parses it.
    #[serde(serialize_with = "raw_json")]
    pub attrs: Option<String>,
}

fn raw_json<S: serde::Serializer>(v: &Option<String>, ser: S) -> Result<S::Ok, S::Error> {
    use serde::Serialize as _;
    match v
        .as_deref()
        .and_then(|a| serde_json::from_str::<&serde_json::value::RawValue>(a).ok())
    {
        Some(raw) => raw.serialize(ser),
        None => ser.serialize_none(),
    }
}

impl EventJson {
    fn from_row(ev: &EventRow, body_cap: Option<usize>) -> Self {
        Self {
            id: event_id(&ev.day, ev.row_id),
            time: iso(ev.ts),
            kind: ev.kind.as_str().to_owned(),
            service: ev.service.clone(),
            name: ev.name.clone(),
            severity: ev.severity.map(|s| severity_name(Some(s)).to_owned()),
            status: ev.status.clone(),
            err: ev.err,
            dur_ms: ev.dur.map(|d| d as f64 / 1e6),
            trace_id: ev.trace_id.map(|t| hex(&t)),
            span_id: ev.span_id.map(|t| hex(&t)),
            parent_id: ev.parent_id.map(|t| hex(&t)),
            session_id: ev.session_id.clone(),
            request_id: ev.request_id.clone(),
            artifact: ev.artifact.clone(),
            body: match body_cap {
                Some(n) => ev.body.as_deref().map(|b| one_line(b, n)),
                None => ev.body.clone(),
            },
            attrs: ev.attrs.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceItem {
    pub depth: usize,
    pub offset_ms: f64,
    #[serde(flatten)]
    pub event: EventJson,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceView {
    pub trace_id: Option<String>,
    pub start: Option<String>,
    pub duration_ms: f64,
    pub spans: usize,
    pub errors: usize,
    pub items: Vec<TraceItem>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventView {
    pub event: EventJson,
    pub host: Option<String>,
    pub version: Option<String>,
    pub pid: Option<i64>,
    pub group: Option<String>,
    pub trace: Option<TraceView>,
    /// Same service ±30 s (for a crash: the 30 s after it).
    pub context: Vec<EventJson>,
    /// Crash only: top frames.
    pub frames: Vec<String>,
    /// Crash only: same service (and pid) in the 2 minutes before.
    pub breadcrumbs: Vec<EventJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupView {
    pub group: String,
    pub service: String,
    pub kind: String,
    pub name: Option<String>,
    pub message: String,
    pub count: u64,
    pub first: String,
    pub last: String,
    pub samples: Vec<EventJson>,
    pub traces: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlowSpan {
    pub name: String,
    pub service: String,
    pub dur_ms: f64,
    pub p50_ms: Option<f64>,
    pub trace_id: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunView {
    pub run: EventJson,
    pub command: String,
    pub exit_code: Option<serde_json::Value>,
    pub failed_tests: Vec<EventJson>,
    pub slowest_spans: Vec<SlowSpan>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineTrace {
    pub trace_id: Option<String>,
    pub root: Option<String>,
    pub first: String,
    pub last: String,
    pub events: usize,
    pub errors: Vec<EventJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineView {
    /// `session_id` or `request_id`.
    pub key: String,
    pub value: String,
    pub events: usize,
    pub truncated: bool,
    pub traces: Vec<TimelineTrace>,
}

impl Answer for ShowAnswer {
    fn text(&self) -> String {
        let mut out = String::new();
        let n = self.lines.len();
        // The cap covers the whole answer: body, the cut marker, `searched:` and `next:`.
        let footer = finish(String::new(), &self.searched.line(), &self.next)
            .lines()
            .count();
        let room = SHOW_LINE_CAP.saturating_sub(footer);
        let keep = if self.full || n <= room {
            n
        } else {
            room.saturating_sub(1)
        };
        for l in &self.lines[..keep] {
            out.push_str(l);
            out.push('\n');
        }
        if keep < n {
            out.push_str(&format!(
                "… {} more lines: motel show {} --full\n",
                count((n - keep) as u64),
                shell_arg(&self.id)
            ));
        }
        finish(out, &self.searched.line(), &self.next)
    }

    fn json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

struct Built {
    view: ShowView,
    lines: Vec<String>,
    next: Vec<String>,
    start: i64,
    end: i64,
    notes: Vec<String>,
}

pub(crate) fn show(q: &Query, id: &str, full: bool) -> Result<ShowAnswer, QueryError> {
    let ctx = Ctx::new(q);
    let id = id.trim().to_owned();
    let mut notes = Vec::new();
    let built = match classify(&id) {
        ShowId::Trace(t) => match show_trace(&ctx, Some(&t), None)? {
            Some(b) => b,
            None => show_other(&ctx, &id, &["trace"])?,
        },
        ShowId::Span(s) => {
            let (span, timed_out) = ctx.find_span(&s)?;
            if timed_out {
                notes.push("span lookup reads whole days; stopped at its 2 s budget".to_owned());
            }
            match span {
                Some(sp) => {
                    let t = sp.trace_id;
                    match t {
                        Some(t) => show_trace(&ctx, Some(&t), Some(sp))?,
                        None => {
                            notes.push("the span has no trace id; showing it alone".to_owned());
                            show_trace(&ctx, None, Some(sp))?
                        }
                    }
                    .unwrap_or_else(|| not_found(&ctx, &id, &["span"]))
                }
                None => show_other(&ctx, &id, &["span"])?,
            }
        }
        ShowId::Event(r) => match ctx.event(&r)? {
            Some(ev) => show_event(&ctx, ev, full)?,
            None => not_found(&ctx, &id, &["event"]),
        },
        ShowId::Group(g) => show_group(&ctx, &g)?,
        ShowId::RunLast => match ctx.run(None)? {
            Some(ev) => show_run(&ctx, ev)?,
            None => not_found(&ctx, &id, &["run"]),
        },
        ShowId::Run(n) => match ctx.run(Some(n))? {
            Some(ev) => show_run(&ctx, ev)?,
            None => not_found(&ctx, &id, &["run"]),
        },
        ShowId::Other(_) => show_other(&ctx, &id, &[])?,
    };
    let mut searched = ctx.searched(built.start, built.end);
    searched.notes.extend(notes);
    searched.notes.extend(built.notes);
    Ok(ShowAnswer {
        id,
        searched,
        view: built.view,
        next: built.next,
        lines: built.lines,
        full,
    })
}

fn not_found(ctx: &Ctx<'_>, id: &str, kinds: &[&str]) -> Built {
    let kinds: Vec<String> = kinds.iter().map(|s| s.to_string()).collect();
    let start = ctx.now - 14 * NS_PER_DAY;
    let what = if kinds.is_empty() {
        "nothing".to_owned()
    } else {
        match kinds.split_last() {
            Some((last, [])) => format!("no {last}"),
            Some((last, rest)) => format!("no {} or {last}", rest.join(", ")),
            None => "nothing".to_owned(),
        }
    };
    Built {
        notes: Vec::new(),
        lines: vec![format!("{what} matched {id:?} in the last 14 days.")],
        view: ShowView::NotFound {
            searched_for: kinds,
        },
        next: vec![
            "motel why".to_owned(),
            motel_sql(&format!(
                "select * from events where instr(body, '{}') > 0 limit 20",
                crate::render::sql_str(id)
            )),
        ],
        start,
        end: ctx.now,
    }
}

// ---------------------------------------------------------------- trace and span

/// A trace, or with `focus` a span inside its trace. A focused span with no trace id, or
/// whose trace read came back empty (a time budget), is shown as a one-row tree.
fn show_trace(
    ctx: &Ctx<'_>,
    trace_id: Option<&[u8; 16]>,
    focus: Option<EventRow>,
) -> Result<Option<Built>, QueryError> {
    let (mut rows, truncated) = match trace_id {
        Some(t) => ctx.trace(t)?,
        None => (Vec::new(), false),
    };
    if rows.is_empty() {
        match &focus {
            Some(sp) => rows.push(sp.clone()),
            None => return Ok(None),
        }
    }
    let (view, tree_lines) = trace_view(
        ctx,
        trace_id,
        &rows,
        truncated,
        focus.as_ref().and_then(|f| f.span_id),
    );
    let mut lines = Vec::new();
    let mut next = Vec::new();
    let first_err = rows.iter().find(|r| r.err && r.kind != EventKind::Run);

    let view = match focus {
        Some(sp) => {
            lines.extend(span_block(&sp, ctx));
            lines.push(String::new());
            lines.extend(tree_lines);
            let span = EventJson::from_row(&sp, None);
            if sp.err {
                next.push(format!("motel show {}", event_id(&sp.day, sp.row_id)));
            }
            if let Some(t) = trace_id {
                next.push(format!("motel show {}", hex(t)));
            }
            ShowView::Span {
                span: Box::new(span),
                trace: Box::new(view),
            }
        }
        None => {
            lines.extend(tree_lines);
            ShowView::Trace(Box::new(view))
        }
    };
    if let Some(e) = first_err {
        let eid = event_id(&e.day, e.row_id);
        if !next.contains(&format!("motel show {eid}")) {
            next.push(format!("motel show {eid}"));
        }
        if let Some(g) = event_group_id(e) {
            next.push(format!("motel show {g}"));
        }
    }
    if let Some(s) = rows.iter().find_map(|r| r.session_id.clone()) {
        next.push(format!("motel show {}", shell_arg(&s)));
    }
    if next.is_empty() {
        if let Some(r) = rows.first() {
            next.push(format!("motel why {}", shell_arg(&r.service)));
        }
    }
    next.truncate(3);
    let start = rows.first().map_or(ctx.now, |r| r.ts);
    let end = rows
        .iter()
        .map(|r| r.ts + r.dur.unwrap_or(0))
        .max()
        .unwrap_or(ctx.now);
    Ok(Some(Built {
        notes: Vec::new(),
        view,
        lines,
        next,
        start: start.min(ctx.now - 14 * NS_PER_DAY),
        end: end.max(ctx.now),
    }))
}

/// Depth-first order: children (spans and the point events attached to them) by time.
fn trace_order(rows: &[EventRow]) -> Vec<(usize, usize)> {
    let mut span_idx: HashMap<[u8; 8], usize> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if r.kind == EventKind::Span {
            if let Some(s) = r.span_id {
                span_idx.entry(s).or_insert(i);
            }
        }
    }
    let mut children: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        let parent = if r.kind == EventKind::Span {
            r.parent_id
                .and_then(|p| span_idx.get(&p).copied())
                .filter(|p| *p != i)
        } else {
            r.span_id.and_then(|s| span_idx.get(&s).copied())
        };
        children.entry(parent).or_default().push(i);
    }
    let mut out = Vec::with_capacity(rows.len());
    let mut seen = HashSet::new();
    let mut stack: Vec<(usize, usize)> = children
        .get(&None)
        .map(|v| v.iter().rev().map(|i| (*i, 0)).collect())
        .unwrap_or_default();
    while let Some((i, depth)) = stack.pop() {
        if !seen.insert(i) {
            continue;
        }
        out.push((i, depth));
        if let Some(kids) = children.get(&Some(i)) {
            for k in kids.iter().rev() {
                stack.push((*k, depth + 1));
            }
        }
    }
    // Rows caught in a parent cycle still get printed, at the root.
    for i in 0..rows.len() {
        if !seen.contains(&i) {
            out.push((i, 0));
        }
    }
    out
}

fn trace_view(
    ctx: &Ctx<'_>,
    trace_id: Option<&[u8; 16]>,
    rows: &[EventRow],
    truncated: bool,
    focus: Option<[u8; 8]>,
) -> (TraceView, Vec<String>) {
    let (now, tz) = (ctx.now, ctx.tz);
    let start = rows.iter().map(|r| r.ts).min().unwrap_or(0);
    let end = rows
        .iter()
        .map(|r| r.ts + r.dur.unwrap_or(0))
        .max()
        .unwrap_or(start);
    let spans = rows.iter().filter(|r| r.kind == EventKind::Span).count();
    let errors = rows.iter().filter(|r| r.err).count();
    let logs = rows.iter().filter(|r| r.kind == EventKind::Log).count();
    let order = trace_order(rows);

    let root = order
        .iter()
        .map(|(i, _)| &rows[*i])
        .find(|r| r.kind == EventKind::Span)
        .or(rows.first());
    let mut services: Vec<&str> = Vec::new();
    for r in rows {
        if !services.contains(&r.service.as_str()) {
            services.push(&r.service);
        }
    }
    let mut header = match trace_id {
        Some(t) => format!("trace {}", hex(t)),
        None => "trace -".to_owned(),
    };
    if let Some(r) = root {
        header.push_str(&format!(" · {}", r.name.as_deref().unwrap_or("?")));
    }
    header.push_str(&format!(" · {}", fmt_dur(end - start)));
    let mut counts = vec![plural(spans as u64, "span", "spans")];
    if logs > 0 {
        counts.push(plural(logs as u64, "log", "logs"));
    }
    let others = rows.len() - spans - logs;
    if others > 0 {
        counts.push(plural(others as u64, "other event", "other events"));
    }
    counts.push(plural(errors as u64, "error", "errors"));
    header.push_str(&format!(
        " · {} · {}",
        counts.join(", "),
        fmt_time(start, now, tz)
    ));
    header.push_str(&format!(" · {}", services.join(", ")));

    let mut table_rows = Vec::with_capacity(order.len());
    let mut parent_service: Vec<String> = Vec::new();
    let mut items = Vec::with_capacity(order.len());
    for (i, depth) in &order {
        let r = &rows[*i];
        parent_service.truncate(*depth);
        let show_svc = parent_service.last().is_none_or(|p| p != &r.service);
        let label = trace_label(r, show_svc);
        if r.kind == EventKind::Span {
            parent_service.push(r.service.clone());
        }
        let mut cells = Vec::with_capacity(4);
        if focus.is_some() {
            let hit = r.kind == EventKind::Span && r.span_id == focus;
            cells.push(if hit { ">".to_owned() } else { String::new() });
        }
        cells.push(if r.ts == start {
            "+0ms".to_owned()
        } else {
            format!("+{}", fmt_dur(r.ts - start))
        });
        cells.push(if r.kind == EventKind::Span {
            r.dur.map(fmt_dur).unwrap_or_default()
        } else {
            String::new()
        });
        cells.push(format!("{}{}", "  ".repeat(*depth), label));
        table_rows.push(cells);
        items.push(TraceItem {
            depth: *depth,
            offset_ms: (r.ts - start) as f64 / 1e6,
            event: EventJson::from_row(r, Some(LIST_BODY_CHARS)),
        });
    }
    let right: &[bool] = if focus.is_some() {
        &[false, true, true]
    } else {
        &[true, true]
    };
    let mut lines = vec![header];
    lines.extend(table(&table_rows, right));
    if truncated {
        lines.push("… trace has more than 5,000 events; showing the first 5,000".to_owned());
    }
    (
        TraceView {
            trace_id: trace_id.map(|t| hex(t)),
            start: Some(iso(start)),
            duration_ms: (end - start) as f64 / 1e6,
            spans,
            errors,
            items,
            truncated,
        },
        lines,
    )
}

fn trace_label(r: &EventRow, show_svc: bool) -> String {
    let svc = if show_svc {
        format!(" [{}]", r.service)
    } else {
        String::new()
    };
    let eid = event_id(&r.day, r.row_id);
    match r.kind {
        EventKind::Span => {
            let mut s = format!("{}{svc}", r.name.as_deref().unwrap_or("?"));
            if r.err {
                let msg = event_message(r);
                s.push_str("  ERR");
                if !msg.is_empty() {
                    s.push(' ');
                    s.push_str(&one_line(&msg, 160));
                }
                s.push_str(&format!("  {eid}"));
            }
            s
        }
        EventKind::Crash => format!(
            "· CRASH{svc} {}  {eid}",
            one_line(&first_line_with_name(r), LIST_BODY_CHARS)
        ),
        EventKind::Run => format!("· RUN{svc} {}  run:{}", run_summary(r, 0), r.row_id),
        EventKind::Test => format!(
            "· TEST{svc} {} {}{}",
            r.name.as_deref().unwrap_or("?"),
            r.status.as_deref().unwrap_or(""),
            if r.err {
                format!("  {eid}")
            } else {
                String::new()
            }
        ),
        _ => {
            let level = match r.kind {
                EventKind::Log => severity_name(r.severity).to_owned(),
                k => k.as_str().to_owned(),
            };
            let body = one_line(&event_message(r), LIST_BODY_CHARS);
            let mut s = format!("· {level}{svc} {body}");
            if r.err {
                s.push_str(&format!("  {eid}"));
            }
            s
        }
    }
}

fn first_line_with_name(r: &EventRow) -> String {
    let msg = event_message(r);
    let first = msg
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    match r.name.as_deref() {
        Some(n) if !first.contains(n) => format!("{n}: {first}"),
        _ => first.to_owned(),
    }
}

fn span_block(sp: &EventRow, ctx: &Ctx<'_>) -> Vec<String> {
    let mut lines = vec![format!(
        "span {} · {} · {} · {} · {}{}",
        sp.span_id.map(|s| hex(&s)).unwrap_or_default(),
        sp.name.as_deref().unwrap_or("?"),
        sp.service,
        sp.dur.map(fmt_dur).unwrap_or_else(|| "-".to_owned()),
        fmt_time_ms(sp.ts, ctx.now, ctx.tz),
        if sp.err { " · ERR" } else { "" }
    )];
    lines.extend(fields_block(sp));
    lines
}

// ---------------------------------------------------------------- event and crash

fn fields_block(ev: &EventRow) -> Vec<String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut add = |k: &str, v: String| rows.push(vec![k.to_owned(), v]);
    if let Some(t) = ev.trace_id {
        let mut v = hex(&t);
        if let Some(s) = ev.span_id {
            v.push_str(&format!(" (span {})", hex(&s)));
        }
        if let Some(p) = ev.parent_id {
            v.push_str(&format!(" (parent {})", hex(&p)));
        }
        add("trace", v);
    }
    if let Some(s) = &ev.session_id {
        add("session", s.clone());
    }
    if let Some(r) = &ev.request_id {
        add("request", r.clone());
    }
    let mut status = Vec::new();
    if let Some(s) = &ev.status {
        status.push(s.clone());
    }
    if let Some(sev) = ev.severity {
        status.push(format!("severity {} ({sev})", severity_name(Some(sev))));
    }
    if ev.err {
        status.push("err".to_owned());
    }
    if !status.is_empty() {
        add("status", status.join(" · "));
    }
    if let Some(a) = &ev.artifact {
        add("artifact", a.clone());
    }
    if let Some(serde_json::Value::Object(m)) = ev
        .attrs
        .as_deref()
        .and_then(|a| serde_json::from_str(a).ok())
    {
        for (k, v) in m {
            let v = match v {
                serde_json::Value::String(s) => s,
                v => v.to_string(),
            };
            add(&format!("  {k}"), one_line(&v, LIST_BODY_CHARS));
        }
    }
    table(&rows, &[])
}

fn show_event(ctx: &Ctx<'_>, ev: EventRow, full: bool) -> Result<Built, QueryError> {
    let (now, tz) = (ctx.now, ctx.tz);
    let res = ctx.resource(&ev)?.unwrap_or_default();
    let eid = event_id(&ev.day, ev.row_id);
    let is_crash = ev.kind == EventKind::Crash;
    let level = match ev.kind {
        EventKind::Log => format!("log {}", severity_name(ev.severity)),
        k => k.as_str().to_owned(),
    };
    let mut head = format!(
        "event {eid} · {level} · {}{} · {}",
        ev.service,
        ev.name
            .as_deref()
            .map(|n| format!(" · {n}"))
            .unwrap_or_default(),
        fmt_time_ms(ev.ts, now, tz)
    );
    if let Some(d) = ev.dur {
        head.push_str(&format!(" · {}", fmt_dur(d)));
    }
    let mut lines = vec![head];
    let mut res_parts = Vec::new();
    if let Some(h) = &res.host {
        res_parts.push(format!("host {h}"));
    }
    if let Some(v) = &res.version {
        res_parts.push(format!("version {v}"));
    }
    let pid = res
        .pid
        .or_else(|| attr(&ev, "process.pid").and_then(|v| v.as_i64()))
        .or_else(|| attr(&ev, "pid").and_then(|v| v.as_i64()));
    if let Some(p) = pid {
        res_parts.push(format!("pid {p}"));
    }
    let mut fields = fields_block(&ev);
    if !res_parts.is_empty() {
        fields.insert(0, format!("resource  {}", res_parts.join(" · ")));
    }
    lines.extend(fields);

    let group = event_group_id(&ev);
    if let Some(g) = &group {
        lines.push(format!("group     {g}"));
    }

    let mut frames = Vec::new();
    let mut breadcrumbs = Vec::new();
    let mut start = ev.ts - 30 * NS_PER_SECOND;
    let end = ev.ts + 30 * NS_PER_SECOND;

    let context: Vec<EventJson> = if is_crash {
        frames = crash_frames(&ev);
        if let Some(first) = event_message(&ev).lines().find(|l| !l.trim().is_empty()) {
            lines.push(format!("crash     {}", one_line(first, LIST_BODY_CHARS)));
        }
        lines.push(format!("top frames ({})", frames.len()));
        for f in &frames {
            lines.push(format!("  {f}"));
        }
        if full {
            push_body(&mut lines, &ev);
        }
        // Breadcrumbs: same service (and pid) in the 2 minutes before.
        start = ev.ts - 2 * NS_PER_MINUTE;
        let (mut crumbs, mut more) =
            ctx.events_between(start, ev.ts, Some(&ev.service), pid, 40, true)?;
        let mut scope = match pid {
            Some(p) => format!("{} pid {p}", ev.service),
            None => ev.service.clone(),
        };
        if crumbs
            .iter()
            .all(|c| c.row_id == ev.row_id && c.day == ev.day)
            && pid.is_some()
        {
            (crumbs, more) = ctx.events_between(start, ev.ts, Some(&ev.service), None, 40, true)?;
            scope = format!(
                "{} (no events tagged with pid {})",
                ev.service,
                pid.unwrap_or(0)
            );
        }
        crumbs.retain(|c| !(c.day == ev.day && c.row_id == ev.row_id));
        lines.push(String::new());
        lines.push(format!(
            "breadcrumbs: {scope}, 2m before · {}{}",
            plural(crumbs.len() as u64, "event", "events"),
            if more { " (newest 40)" } else { "" }
        ));
        lines.extend(event_rows(&crumbs, None, ev.ts, ctx));
        breadcrumbs = crumbs
            .iter()
            .map(|c| EventJson::from_row(c, Some(LIST_BODY_CHARS)))
            .collect();

        let (after, more_after) =
            ctx.events_between(ev.ts + 1, end, Some(&ev.service), None, 20, false)?;
        lines.push(String::new());
        lines.push(format!(
            "after: {} +30s · {}{}",
            ev.service,
            plural(after.len() as u64, "event", "events"),
            if more_after { " (first 20)" } else { "" }
        ));
        lines.extend(event_rows(&after, None, ev.ts, ctx));
        after
            .iter()
            .map(|c| EventJson::from_row(c, Some(LIST_BODY_CHARS)))
            .collect()
    } else {
        push_body(&mut lines, &ev);
        // Centered on the event: the newest CONTEXT_SIDE before it, the event, and the
        // oldest CONTEXT_SIDE after it.
        let is_ev = |c: &EventRow| c.day == ev.day && c.row_id == ev.row_id;
        let (mut around, mut more) = ctx.events_between(
            start,
            ev.ts,
            Some(&ev.service),
            None,
            CONTEXT_SIDE + 1,
            true,
        )?;
        around.retain(|c| !is_ev(c));
        if around.len() > CONTEXT_SIDE {
            around.drain(..around.len() - CONTEXT_SIDE);
            more = true;
        }
        around.push(ev.clone());
        let (after, more_after) =
            ctx.events_between(ev.ts + 1, end, Some(&ev.service), None, CONTEXT_SIDE, false)?;
        around.extend(after);
        lines.push(String::new());
        lines.push(format!(
            "context: {} ±30s · {}{}",
            ev.service,
            plural(around.len() as u64, "event", "events"),
            if more || more_after {
                format!(" (nearest {CONTEXT_SIDE} each side)")
            } else {
                String::new()
            }
        ));
        lines.extend(event_rows(&around, Some((&ev.day, ev.row_id)), ev.ts, ctx));
        around
            .iter()
            .map(|c| EventJson::from_row(c, Some(LIST_BODY_CHARS)))
            .collect()
    };

    let mut trace = None;
    if let Some(t) = ev.trace_id {
        let (rows, truncated) = ctx.trace(&t)?;
        if !rows.is_empty() {
            let (view, tree) = trace_view(ctx, Some(&t), &rows, truncated, None);
            lines.push(String::new());
            let cap = if full { usize::MAX } else { EVENT_TRACE_LINES };
            let n = tree.len();
            lines.extend(tree.into_iter().take(cap));
            if n > cap {
                lines.push(format!(
                    "… {} more trace lines: motel show {}",
                    n - cap,
                    hex(&t)
                ));
            }
            trace = Some(view);
        }
    }

    let mut next = Vec::new();
    if let Some(t) = ev.trace_id {
        next.push(format!("motel show {}", hex(&t)));
    }
    if let Some(g) = &group {
        next.push(format!("motel show {g}"));
    }
    if let Some(s) = &ev.session_id {
        next.push(format!("motel show {}", shell_arg(s)));
    }
    if next.len() < 2 {
        next.push(format!("motel why {}", shell_arg(&ev.service)));
    }
    next.truncate(3);

    let view = EventView {
        event: EventJson::from_row(&ev, None),
        host: res.host,
        version: res.version,
        pid,
        group,
        trace,
        context,
        frames,
        breadcrumbs,
    };
    Ok(Built {
        notes: Vec::new(),
        view: ShowView::Event(Box::new(view)),
        lines,
        next,
        start,
        end,
    })
}

fn push_body(lines: &mut Vec<String>, ev: &EventRow) {
    if let Some(b) = ev.body.as_deref().filter(|b| !b.trim().is_empty()) {
        lines.push("body".to_owned());
        for l in b.lines() {
            lines.push(format!("  {}", l.trim_end()));
        }
    }
}

/// Rows for context and breadcrumb lists; `mark` puts `>` on the focused event.
fn event_rows(
    rows: &[EventRow],
    mark: Option<(&str, i64)>,
    center: i64,
    ctx: &Ctx<'_>,
) -> Vec<String> {
    let mut cells = Vec::with_capacity(rows.len());
    for r in rows {
        let here = mark.is_some_and(|(d, id)| r.day == d && r.row_id == id);
        let offset = r.ts - center;
        let rel = if offset == 0 {
            "0s".to_owned()
        } else if offset < 0 {
            format!("-{}", fmt_dur(-offset))
        } else {
            format!("+{}", fmt_dur(offset))
        };
        let what = match r.kind {
            EventKind::Log => format!("log {}", severity_name(r.severity)),
            EventKind::Span => format!("span {}", r.dur.map(fmt_dur).unwrap_or_default()),
            k => k.as_str().to_owned(),
        };
        let text = match r.kind {
            EventKind::Span => {
                let mut t = r.name.clone().unwrap_or_default();
                if r.err {
                    let m = event_message(r);
                    if !m.is_empty() {
                        t.push_str(": ");
                        t.push_str(&m);
                    }
                }
                t
            }
            _ => {
                let m = event_message(r);
                if m.is_empty() {
                    r.name.clone().unwrap_or_default()
                } else {
                    m
                }
            }
        };
        let mut text = one_line(&text, LIST_BODY_CHARS);
        if r.err {
            text.push_str(&format!("  {}", event_id(&r.day, r.row_id)));
        }
        cells.push(vec![
            if here { ">".to_owned() } else { String::new() },
            fmt_time_ms(r.ts, ctx.now, ctx.tz),
            rel,
            what,
            text,
        ]);
    }
    table(&cells, &[false, false, true])
        .into_iter()
        .map(|l| {
            if l.starts_with('>') {
                l
            } else {
                format!(" {}", l.trim_start())
            }
        })
        .map(|l| format!(" {l}"))
        .collect()
}

/// Top frames from `crash.frames` (array), else frame-looking body lines, else the first lines.
fn crash_frames(ev: &EventRow) -> Vec<String> {
    if let Some(serde_json::Value::Array(a)) = attr(ev, "crash.frames") {
        return a
            .iter()
            .take(8)
            .map(|v| match v {
                serde_json::Value::String(s) => one_line(s, 200),
                v => v.to_string(),
            })
            .collect();
    }
    let body = ev.body.as_deref().unwrap_or("");
    let framey: Vec<String> = body
        .lines()
        .map(str::trim)
        .filter(|l| {
            let mut parts = l.split_whitespace();
            parts.next().is_some_and(|n| {
                let n = n.trim_end_matches(':');
                !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())
            }) && parts.next().is_some()
        })
        .take(8)
        .map(|l| one_line(l, 200))
        .collect();
    if !framey.is_empty() {
        return framey;
    }
    body.lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .take(8)
        .map(|l| one_line(l, 200))
        .collect()
}

// ---------------------------------------------------------------- group

/// `g:` ids name groups of the error kinds kept in day files (crashes, runs and failed tests
/// have event and run ids instead), so a group is searched for in every file on disk, the
/// same reach as `why --since`.
fn show_group(ctx: &Ctx<'_>, gid: &str) -> Result<Built, QueryError> {
    let end = ctx.now;
    let target = u32::from_str_radix(gid.trim_start_matches("g:").get(..8).unwrap_or(""), 16).ok();
    let Some(target) = target else {
        return Ok(not_found(ctx, gid, &["error group"]));
    };
    // Find one member, then count the group within its service, kind and name.
    let mut hit: Option<(u64, ErrRow)> = None;
    ctx.scan_errors(
        &ErrScan {
            start: 0,
            end,
            services: None,
            kind_name: None,
            ordered: false,
            cap: usize::MAX,
            deadline: ctx.deadline,
        },
        |r| {
            let fp = fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg);
            if (fp >> 32) as u32 == target {
                hit = Some((fp, r));
                return false;
            }
            true
        },
    )?;
    let Some((fp, member)) = hit else {
        return Ok(not_found(ctx, gid, &["error group"]));
    };
    let (service, kind, name) = (
        member.service.clone(),
        member.kind.clone(),
        member.name.clone(),
    );

    let mut n = 0u64;
    let mut first = member.ts;
    let mut last = member.ts;
    let mut samples: Vec<EventRef> = Vec::new();
    let mut sample_msgs: HashSet<String> = HashSet::new();
    let mut traces: Vec<([u8; 16], i64)> = Vec::new();
    let mut message = normalize(&member.msg);
    // Newest first across files, so the samples and traces kept are the newest.
    let services = [service.clone()];
    let scan = ctx.scan_errors(
        &ErrScan {
            start: 0,
            end,
            services: Some(&services),
            kind_name: Some((&kind, name.as_deref())),
            ordered: true,
            cap: 1_000_000,
            deadline: ctx.deadline,
        },
        |r| {
            if fingerprint(&r.service, &r.kind, r.name.as_deref(), &r.msg) != fp {
                return true;
            }
            n += 1;
            first = first.min(r.ts);
            last = last.max(r.ts);
            if n == 1 {
                message = normalize(&r.msg);
            }
            if samples.len() < 3 && sample_msgs.insert(r.msg.clone()) {
                samples.push(r.ev.clone());
            }
            if let Some(t) = r.trace_id {
                if traces.len() < 5 && !traces.iter().any(|(x, _)| *x == t) {
                    traces.push((t, r.ts));
                }
            }
            true
        },
    )?;

    let sample_rows: Vec<EventRow> = samples
        .iter()
        .filter_map(|r| ctx.event(r).transpose())
        .collect::<Result<_, _>>()?;
    let (now, tz) = (ctx.now, ctx.tz);
    let mut lines = vec![format!(
        "group {gid} · {service} · {kind}{} · {} · {}",
        name.as_deref().map(|n| format!(" {n}")).unwrap_or_default(),
        plural(n, "event", "events"),
        fmt_range(first, last, now, tz)
    )];
    lines.push(format!("message  {message}"));
    if n == 0 {
        n = 1;
        samples.push(member.ev.clone());
    }
    if scan.truncated {
        lines.push(
            "(count stopped at the scan budget; the group has at least this many)".to_owned(),
        );
    }
    lines.push(format!("samples ({})", sample_rows.len()));
    let rows: Vec<Vec<String>> = sample_rows
        .iter()
        .map(|r| {
            vec![
                fmt_time(r.ts, now, tz),
                event_id(&r.day, r.row_id),
                one_line(&event_message(r), LIST_BODY_CHARS),
            ]
        })
        .collect();
    lines.extend(table(&rows, &[]).into_iter().map(|l| format!("  {l}")));
    lines.push(format!("traces ({})", traces.len()));
    let rows: Vec<Vec<String>> = traces
        .iter()
        .map(|(t, ts)| vec![fmt_time(*ts, now, tz), hex(t)])
        .collect();
    lines.extend(table(&rows, &[]).into_iter().map(|l| format!("  {l}")));

    let mut next = Vec::new();
    if let Some((t, _)) = traces.first() {
        next.push(format!("motel show {}", hex(t)));
    }
    if let Some(r) = sample_rows.first() {
        next.push(format!("motel show {}", event_id(&r.day, r.row_id)));
    }
    next.push(format!("motel why {}", shell_arg(&service)));

    Ok(Built {
        notes: Vec::new(),
        view: ShowView::Group(GroupView {
            group: gid.to_owned(),
            service,
            kind,
            name,
            message,
            count: n,
            first: iso(first),
            last: iso(last),
            samples: sample_rows
                .iter()
                .map(|r| EventJson::from_row(r, Some(LIST_BODY_CHARS)))
                .collect(),
            traces: traces.iter().map(|(t, _)| hex(t)).collect(),
        }),
        lines,
        next,
        start: first.min(ctx.now - 14 * NS_PER_DAY),
        end,
    })
}

// ---------------------------------------------------------------- run

fn show_run(ctx: &Ctx<'_>, run: EventRow) -> Result<Built, QueryError> {
    let (now, tz) = (ctx.now, ctx.tz);
    let start = run.ts;
    let end = run.ts + run.dur.unwrap_or(0);
    let failed = ctx.evidence_rows("test", start, end, true, 200)?;
    let command = attr_str(&run, "run.command")
        .or_else(|| run.name.clone())
        .unwrap_or_else(|| "run".to_owned());
    let exit_code = attr(&run, "exit_code").or_else(|| attr(&run, "process.exit_code"));

    // The run's spans: its trace, else its session's spans during the run, else every span
    // during the run.
    let timed = |r: &EventRow| r.kind == EventKind::Span && r.dur.is_some() && !is_wrapper(r, &run);
    let mut spans: Vec<EventRow> = match run.trace_id {
        Some(t) => ctx.trace(&t)?.0.into_iter().filter(timed).collect(),
        None => Vec::new(),
    };
    if spans.is_empty() {
        if let Some(s) = &run.session_id {
            spans = ctx
                .by_key(s, false, SESSION_LIMIT)?
                .0
                .into_iter()
                .filter(|r| timed(r) && (end <= start || (r.ts >= start && r.ts <= end)))
                .collect();
        }
    }
    if spans.is_empty() {
        spans = ctx
            .slowest_spans(start, end.max(start + 1), 11)?
            .into_iter()
            .filter(timed)
            .collect();
    }
    spans.sort_by(|a, b| b.dur.cmp(&a.dur).then(a.ts.cmp(&b.ts)));
    spans.truncate(10);

    let mut slow = Vec::new();
    let mut p50_cache: HashMap<(String, String), Option<i64>> = HashMap::new();
    for sp in &spans {
        let name = sp.name.clone().unwrap_or_default();
        let key = (sp.service.clone(), name.clone());
        let p50 = match p50_cache.get(&key) {
            Some(v) => *v,
            None => {
                let v = ctx.p50(&sp.service, &name, start - 7 * NS_PER_DAY, start - 1)?;
                p50_cache.insert(key, v);
                v
            }
        };
        slow.push((sp, p50));
    }

    let mut lines = vec![format!(
        "run run:{} · {} · {} · {}",
        run.row_id,
        one_line(&command, LIST_BODY_CHARS),
        match &exit_code {
            Some(c) => format!("exit {c}"),
            None => run.status.clone().unwrap_or_else(|| "-".to_owned()),
        },
        if run.dur.is_some() {
            format!(
                "{} · {}",
                run.dur.map(fmt_dur).unwrap_or_default(),
                fmt_range(start, end, now, tz)
            )
        } else {
            fmt_time(start, now, tz)
        }
    )];
    lines.extend(fields_block(&run));
    lines.push(format!("failed tests ({})", failed.len()));
    for t in &failed {
        let msg = event_message(t);
        let mut line = format!(
            "  {}  {}  {}",
            fmt_time(t.ts, now, tz),
            t.name.as_deref().unwrap_or("?"),
            event_id(&t.day, t.row_id)
        );
        if !msg.is_empty() {
            line.push_str(&format!("\n    {}", one_line(&msg, LIST_BODY_CHARS)));
        }
        lines.extend(line.lines().map(str::to_owned));
    }
    lines.push(format!(
        "slowest spans ({}) vs 7-day p50 by name",
        slow.len()
    ));
    let mut rows = vec![vec![
        "dur".to_owned(),
        "p50".to_owned(),
        "x p50".to_owned(),
        "service".to_owned(),
        "trace".to_owned(),
        "span".to_owned(),
    ]];
    for (sp, p50) in &slow {
        let d = sp.dur.unwrap_or(0);
        rows.push(vec![
            fmt_dur(d),
            p50.map(fmt_dur).unwrap_or_else(|| "-".to_owned()),
            match p50 {
                Some(p) if *p > 0 => format!("{:.1}x", d as f64 / *p as f64),
                _ => "new".to_owned(),
            },
            sp.service.clone(),
            sp.trace_id
                .map(|t| hex(&t))
                .unwrap_or_else(|| "-".to_owned()),
            one_line(sp.name.as_deref().unwrap_or("?"), 120),
        ]);
    }
    if !slow.is_empty() {
        lines.extend(
            table(&rows, &[true, true, true])
                .into_iter()
                .map(|l| format!("  {l}")),
        );
    }

    let mut next = Vec::new();
    if let Some(t) = failed.first() {
        next.push(format!("motel show {}", event_id(&t.day, t.row_id)));
    }
    if let Some(t) = slow.first().and_then(|(s, _)| s.trace_id) {
        next.push(format!("motel show {}", hex(&t)));
    }
    next.push(format!(
        "motel why --since run:{}",
        if is_last(ctx, &run)? {
            "last".to_owned()
        } else {
            run.row_id.to_string()
        }
    ));
    // `--since` takes run:last only; for an older run use its start time.
    if let Some(last) = next.last_mut() {
        if !last.ends_with("run:last") {
            *last = format!("motel why --since {}", iso(start));
        }
    }

    let view = RunView {
        run: EventJson::from_row(&run, None),
        command,
        exit_code,
        failed_tests: failed
            .iter()
            .map(|t| EventJson::from_row(t, Some(LIST_BODY_CHARS)))
            .collect(),
        slowest_spans: slow
            .iter()
            .map(|(sp, p50)| SlowSpan {
                name: sp.name.clone().unwrap_or_default(),
                service: sp.service.clone(),
                dur_ms: sp.dur.unwrap_or(0) as f64 / 1e6,
                p50_ms: p50.map(|p| p as f64 / 1e6),
                trace_id: sp.trace_id.map(|t| hex(&t)),
                id: event_id(&sp.day, sp.row_id),
            })
            .collect(),
    };
    Ok(Built {
        view: ShowView::Run(Box::new(view)),
        lines,
        next,
        start,
        end: end.max(start + 1),
        notes: vec!["p50s come from the 7 days before the run".to_owned()],
    })
}

/// A span that mirrors the run itself: the run's own span, or a root of the run's trace that
/// lies within the run (50 ms slack) and covers at least 90% of it.
fn is_wrapper(sp: &EventRow, run: &EventRow) -> bool {
    if sp.span_id.is_some() && sp.span_id == run.span_id {
        return true;
    }
    if sp.parent_id.is_some() || run.trace_id.is_none() || sp.trace_id != run.trace_id {
        return false;
    }
    let (Some(d), Some(rd)) = (sp.dur, run.dur) else {
        return false;
    };
    let slack = 50 * NS_PER_MILLI;
    sp.ts >= run.ts - slack && sp.ts + d <= run.ts + rd + slack && d >= rd / 10 * 9
}

fn is_last(ctx: &Ctx<'_>, run: &EventRow) -> Result<bool, QueryError> {
    Ok(ctx.run(None)?.is_some_and(|l| l.row_id == run.row_id))
}

// ---------------------------------------------------------------- session and request

fn show_other(ctx: &Ctx<'_>, id: &str, tried: &[&str]) -> Result<Built, QueryError> {
    for by_request in [false, true] {
        let (rows, truncated) = ctx.by_key(id, by_request, SESSION_LIMIT)?;
        if !rows.is_empty() {
            return Ok(timeline(ctx, id, by_request, rows, truncated));
        }
    }
    let mut kinds: Vec<&str> = tried.to_vec();
    kinds.extend(["session", "request"]);
    Ok(not_found(ctx, id, &kinds))
}

fn timeline(
    ctx: &Ctx<'_>,
    value: &str,
    by_request: bool,
    rows: Vec<EventRow>,
    truncated: bool,
) -> Built {
    let (now, tz) = (ctx.now, ctx.tz);
    let key = if by_request { "request" } else { "session" };
    let mut order: Vec<Option<[u8; 16]>> = Vec::new();
    let mut by_trace: HashMap<Option<[u8; 16]>, Vec<&EventRow>> = HashMap::new();
    for r in &rows {
        if !by_trace.contains_key(&r.trace_id) {
            order.push(r.trace_id);
        }
        by_trace.entry(r.trace_id).or_default().push(r);
    }
    let first = rows.first().map_or(now, |r| r.ts);
    let last = rows.last().map_or(now, |r| r.ts);
    let errors = rows.iter().filter(|r| r.err).count();
    let mut lines = vec![format!(
        "{key} {value} · {} in {} · {} · {}",
        plural(rows.len() as u64, "event", "events"),
        plural(
            order.iter().filter(|t| t.is_some()).count() as u64,
            "trace",
            "traces"
        ),
        plural(errors as u64, "error", "errors"),
        fmt_range(first, last, now, tz)
    )];
    if truncated {
        lines.push(format!("(newest {} events)", count(SESSION_LIMIT as u64)));
    }
    let mut traces = Vec::new();
    let mut worst: Option<(usize, [u8; 16])> = None;
    let mut first_err: Option<&EventRow> = None;
    for t in &order {
        let evs = &by_trace[t];
        let root = evs
            .iter()
            .find(|r| r.kind == EventKind::Span && r.parent_id.is_none())
            .or_else(|| evs.iter().find(|r| r.kind == EventKind::Span))
            .copied();
        let t_first = evs.first().map_or(0, |r| r.ts);
        let t_last = evs
            .iter()
            .map(|r| r.ts + r.dur.unwrap_or(0))
            .max()
            .unwrap_or(t_first);
        let errs: Vec<&EventRow> = evs.iter().filter(|r| r.err).copied().collect();
        if let (Some(tid), false) = (t, errs.is_empty()) {
            if worst.is_none_or(|(n, _)| errs.len() > n) {
                worst = Some((errs.len(), *tid));
            }
        }
        if first_err.is_none() {
            first_err = errs.first().copied();
        }
        let head = match t {
            Some(tid) => format!(
                "{}  trace {}  {}  {}  {}{}",
                fmt_time(t_first, now, tz),
                hex(tid),
                root.and_then(|r| r.name.clone())
                    .map(|n| one_line(&n, 80))
                    .unwrap_or_else(|| "?".to_owned()),
                fmt_dur(t_last - t_first),
                plural(evs.len() as u64, "event", "events"),
                if errs.is_empty() {
                    String::new()
                } else {
                    format!(", {}", plural(errs.len() as u64, "error", "errors"))
                }
            ),
            None => format!(
                "{}  (no trace)  {}{}",
                fmt_time(t_first, now, tz),
                plural(evs.len() as u64, "event", "events"),
                if errs.is_empty() {
                    String::new()
                } else {
                    format!(", {}", plural(errs.len() as u64, "error", "errors"))
                }
            ),
        };
        lines.push(head);
        let shown: Vec<&EventRow> = if t.is_some() {
            errs.iter().take(3).copied().collect()
        } else {
            evs.iter().take(10).copied().collect()
        };
        let rows: Vec<Vec<String>> = shown
            .iter()
            .map(|r| {
                let what = match r.kind {
                    EventKind::Log => format!("log {}", severity_name(r.severity)),
                    k => k.as_str().to_owned(),
                };
                let text = match (r.kind, r.name.as_deref()) {
                    (EventKind::Span, Some(n)) => format!("{n}: {}", event_message(r)),
                    _ => event_message(r),
                };
                vec![
                    fmt_time(r.ts, now, tz),
                    what,
                    event_id(&r.day, r.row_id),
                    one_line(&text, LIST_BODY_CHARS),
                ]
            })
            .collect();
        lines.extend(table(&rows, &[]).into_iter().map(|l| format!("    {l}")));
        let hidden = if t.is_some() {
            errs.len().saturating_sub(3)
        } else {
            evs.len().saturating_sub(10)
        };
        if hidden > 0 {
            lines.push(format!("    … {hidden} more"));
        }
        traces.push(TimelineTrace {
            trace_id: t.map(|x| hex(&x)),
            root: root.and_then(|r| r.name.clone()),
            first: iso(t_first),
            last: iso(t_last),
            events: evs.len(),
            errors: errs
                .iter()
                .map(|r| EventJson::from_row(r, Some(LIST_BODY_CHARS)))
                .collect(),
        });
    }

    let mut next = Vec::new();
    if let Some((_, t)) = worst.or_else(|| order.iter().flatten().next().map(|t| (0, *t))) {
        next.push(format!("motel show {}", hex(&t)));
    }
    if let Some(e) = first_err {
        next.push(format!("motel show {}", event_id(&e.day, e.row_id)));
    }
    if let Some(svc) = rows.first().map(|r| r.service.clone()) {
        next.push(format!("motel why {}", shell_arg(&svc)));
    }
    next.truncate(3);
    Built {
        notes: Vec::new(),
        view: ShowView::Timeline(TimelineView {
            key: format!("{key}_id"),
            value: value.to_owned(),
            events: rows.len(),
            truncated,
            traces,
        }),
        lines,
        next,
        start: ctx.now - 14 * NS_PER_DAY,
        end: ctx.now,
    }
}
