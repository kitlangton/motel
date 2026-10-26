//! `motel sql` and `motel schema`: the escape hatch (`docs/agent-api.md` §6).

use motel_store::{SqlValue, StoreError, TimeWindow, NS_PER_DAY};
use serde::Serialize;

use crate::data::Ctx;
use crate::render::{count, finish, one_line, table, LIST_BODY_CHARS};
use crate::searched::Searched;
use crate::time::fmt_time;
use crate::{Answer, Query, QueryError};

/// Columns of the `events` view, with one-line meanings.
pub const COLUMNS: &[(&str, &str)] = &[
    (
        "id",
        "row id within its file (not unique across days; `show` ids are e:<day>.<id>)",
    ),
    ("ts", "event time, Unix ns (span start; log/crash time)"),
    ("ingest_ts", "arrival time at motel, Unix ns"),
    ("dur", "span or run duration in ns; null for point events"),
    (
        "kind",
        "span, log, metric, crash, profile, inspect, run, test",
    ),
    ("service", "service.name"),
    (
        "severity",
        "OTLP severity number: 9 INFO, 13 WARN, 17 ERROR, 21 FATAL",
    ),
    (
        "status",
        "span status or run/test result (ok, error, fail, pass, ...)",
    ),
    (
        "err",
        "1 for errors: crashes, severity >= 17, status error/fail",
    ),
    ("name", "span name, log event name, test name, run command"),
    (
        "trace_id",
        "16-byte blob; hex(trace_id) gives the 32-hex id",
    ),
    ("span_id", "8-byte blob"),
    ("parent_id", "8-byte blob; null for root spans"),
    ("session_id", "session id attribute, when the app sends one"),
    ("request_id", "request id attribute, when the app sends one"),
    (
        "res",
        "resource id within its file; use host, version and pid instead",
    ),
    ("src", "ingest source id"),
    (
        "artifact",
        "path to a stored artifact (crash report, profile)",
    ),
    ("body", "log body or error message, at most 16 KiB"),
    (
        "attrs",
        "attributes as JSONB: read with attr(attrs, 'key') or json(attrs)",
    ),
    (
        "host",
        "host.name of the sending process (from its resource)",
    ),
    ("version", "service.version of the sending process"),
    ("pid", "process.pid of the sending process"),
];

pub const EXAMPLES: &[(&str, &str)] = &[
    (
        "errors by service and name",
        "select service, name, count(*) n from events where err group by 1, 2 order by n desc",
    ),
    (
        "slowest spans",
        "select service, name, dur/1e6 ms, hex(trace_id) trace from events where kind = 'span' order by dur desc limit 20",
    ),
    (
        "one HTTP route",
        "select attr(attrs, 'http.route') route, count(*) n, avg(dur)/1e6 avg_ms from events where kind = 'span' group by 1 order by n desc",
    ),
    (
        "log lines mentioning a word",
        "select datetime(ts/1e9, 'unixepoch', 'localtime') t, service, body from events where kind = 'log' and instr(body, 'timeout') > 0 order by ts desc limit 50",
    ),
    (
        "events per pid",
        "select pid, service, count(*) n from events group by 1, 2 order by n desc",
    ),
];

/// The static part of `schema`, also appended to SQL errors.
pub fn reference() -> String {
    let mut out = String::from(
        "view events (24h window by default, at most 30 days; 1,000 rows; 2s deadline; read-only)\n",
    );
    let rows: Vec<Vec<String>> = COLUMNS
        .iter()
        .map(|(c, m)| vec![format!("  {c}"), (*m).to_owned()])
        .collect();
    for l in table(&rows, &[]) {
        out.push_str(&l);
        out.push('\n');
    }
    out.push_str(
        "host, version and pid are per-event columns; resource ids are per file, so there is no resources table\n",
    );
    out.push_str("attr(attrs, 'http.route') reads one attribute (text, number or null)\n");
    out.push_str("examples\n");
    for (what, sql) in EXAMPLES {
        out.push_str(&format!("  -- {what}\n  {sql}\n"));
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlAnswer {
    pub query: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Stopped at 1,000 rows or 1 MiB.
    pub truncated: bool,
    pub searched: Searched,
    pub next: Vec<String>,
    #[serde(skip)]
    cells: Vec<Vec<String>>,
}

pub(crate) fn sql(
    q: &Query,
    query: &str,
    window: Option<TimeWindow>,
) -> Result<SqlAnswer, QueryError> {
    let ctx = Ctx::new(q);
    if let Some(w) = window {
        if w.start_ns > w.end_ns {
            return Err(QueryError::BadTime(format!(
                "--since {} is after --until {}",
                crate::time::iso(w.start_ns),
                crate::time::iso(w.end_ns)
            )));
        }
    }
    let table = match q.reader.sql_table(query, window) {
        Ok(t) => t,
        Err(e @ (StoreError::Sqlite(_) | StoreError::UnauthorizedSql(_) | StoreError::Other(_))) => {
            return Err(QueryError::Sql {
                message: e.to_string(),
                schema: reference(),
            })
        }
        Err(StoreError::QueryDeadlineExceeded) => {
            return Err(QueryError::Sql {
                message: "query ran past the 2s deadline; narrow the window or add a filter on ts, service or err".to_owned(),
                schema: reference(),
            })
        }
        Err(e) => return Err(e.into()),
    };
    let win = table.meta.window;
    // Report the files the store attached for this window.
    let mut files = ctx.files(win.start_ns, win.end_ns);
    files.truncate(32);
    for f in &files {
        ctx.visited.borrow_mut().add(&f.day);
    }
    let searched = ctx.searched(win.start_ns, win.end_ns);

    let rows: Vec<Vec<serde_json::Value>> = table
        .rows
        .iter()
        .map(|r| r.iter().map(json_value).collect())
        .collect();
    let cells: Vec<Vec<String>> = table
        .rows
        .iter()
        .map(|r| r.iter().map(text_cell).collect())
        .collect();
    let next = if rows.is_empty() {
        vec!["motel schema".to_owned(), "motel why".to_owned()]
    } else {
        vec!["motel why".to_owned()]
    };
    Ok(SqlAnswer {
        query: query.to_owned(),
        columns: table.columns,
        rows,
        truncated: table.meta.truncated,
        searched,
        next,
        cells,
    })
}

fn json_value(v: &SqlValue) -> serde_json::Value {
    match v {
        SqlValue::Null => serde_json::Value::Null,
        SqlValue::Integer(i) => (*i).into(),
        SqlValue::Real(f) => {
            serde_json::Number::from_f64(*f).map_or(serde_json::Value::Null, Into::into)
        }
        SqlValue::Text(s) => s.clone().into(),
        SqlValue::Blob(b) => blob_text(b).into(),
    }
}

fn blob_text(b: &[u8]) -> String {
    if b.len() <= 32 {
        crate::ids::hex(b)
    } else {
        format!("<blob {} bytes>", b.len())
    }
}

fn text_cell(v: &SqlValue) -> String {
    match v {
        SqlValue::Null => "null".to_owned(),
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{f:.0}")
            } else {
                let s = format!("{f:.3}");
                s.trim_end_matches('0').trim_end_matches('.').to_owned()
            }
        }
        SqlValue::Text(s) => one_line(s, LIST_BODY_CHARS),
        SqlValue::Blob(b) => blob_text(b),
    }
}

impl Answer for SqlAnswer {
    fn text(&self) -> String {
        let mut out = String::new();
        if self.rows.is_empty() {
            out.push_str("0 rows\n");
        } else {
            let numeric: Vec<bool> = (0..self.columns.len())
                .map(|i| {
                    self.rows
                        .iter()
                        .all(|r| r.get(i).is_some_and(|v| v.is_number() || v.is_null()))
                })
                .collect();
            let mut all = Vec::with_capacity(self.cells.len() + 1);
            all.push(self.columns.clone());
            all.extend(self.cells.iter().cloned());
            for l in table(&all, &numeric) {
                out.push_str(&l);
                out.push('\n');
            }
            out.push_str(&format!(
                "{} row{}{}\n",
                count(self.rows.len() as u64),
                if self.rows.len() == 1 { "" } else { "s" },
                if self.truncated {
                    " (truncated at the 1,000 row / 1 MiB cap)"
                } else {
                    ""
                }
            ));
        }
        finish(out, &self.searched.line(), &self.next)
    }

    fn json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceSeen {
    pub service: String,
    pub events: u64,
    pub last: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaAnswer {
    pub columns: Vec<(String, String)>,
    pub kinds: Vec<String>,
    pub services: Vec<ServiceSeen>,
    pub helpers: Vec<String>,
    pub examples: Vec<String>,
    pub searched: Searched,
    pub next: Vec<String>,
    #[serde(skip)]
    service_lines: Vec<Vec<String>>,
}

pub(crate) fn schema(q: &Query) -> Result<SchemaAnswer, QueryError> {
    let ctx = Ctx::new(q);
    let start = ctx.now - 7 * NS_PER_DAY;
    let seen = ctx.services(start, ctx.now)?;
    let searched = ctx.searched(start, ctx.now);
    let service_lines = seen
        .iter()
        .map(|(s, n, last)| {
            vec![
                format!("  {s}"),
                count(*n),
                fmt_time(*last, ctx.now, ctx.tz),
            ]
        })
        .collect();
    let next = match seen.first() {
        Some((s, _, _)) => vec![
            format!("motel why {}", crate::render::shell_arg(s)),
            crate::render::motel_sql(&format!(
                "select kind, name, count(*) n from events where service = '{}' group by 1, 2 order by n desc limit 20",
                crate::render::sql_str(s)
            )),
        ],
        None => vec!["motel why".to_owned()],
    };
    Ok(SchemaAnswer {
        columns: COLUMNS
            .iter()
            .map(|(c, m)| ((*c).to_owned(), (*m).to_owned()))
            .collect(),
        kinds: [
            "span", "log", "metric", "crash", "profile", "inspect", "run", "test",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect(),
        services: seen
            .iter()
            .map(|(s, n, last)| ServiceSeen {
                service: s.clone(),
                events: *n,
                last: crate::time::iso(*last),
            })
            .collect(),
        helpers: vec!["attr(attrs, 'key') reads one attribute (text, number or null)".to_owned()],
        examples: EXAMPLES.iter().map(|(_, s)| (*s).to_owned()).collect(),
        searched,
        next,
        service_lines,
    })
}

impl Answer for SchemaAnswer {
    fn text(&self) -> String {
        let mut out = reference();
        if self.services.is_empty() {
            out.push_str("services (7 days): none\n");
        } else {
            out.push_str(&format!("services (7 days): {}\n", self.services.len()));
            let mut rows = vec![vec![
                "  service".to_owned(),
                "events".to_owned(),
                "last".to_owned(),
            ]];
            rows.extend(self.service_lines.iter().cloned());
            for l in table(&rows, &[false, true]) {
                out.push_str(&l);
                out.push('\n');
            }
        }
        finish(out, &self.searched.line(), &self.next)
    }

    fn json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}
