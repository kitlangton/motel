//! motel's agent query layer: `why`, `show`, `sql` and `schema` (api.md).
//!
//! Every call returns a typed answer that renders two ways: [`Answer::text`], plain text
//! sized for an agent's context, and [`Answer::json`], the same data plus the `next` list.
//! Each answer says what it searched ([`Searched`]) and ends with 1 to 3 exact follow-up
//! commands.
//!
//! The CLI, HTTP and MCP surfaces all call [`Query`]. Only the CLI and stdio MCP resolve git
//! refs in `--since` ([`Query::resolve_since`] with a `cwd`); HTTP passes `None`.

mod data;
pub mod fingerprint;
pub mod ids;
mod render;
mod searched;
mod show;
pub mod time;
mod why;

use std::fmt;
use std::path::Path;

use motel_store::{Reader, StoreError};

pub use crate::searched::{Searched, Source};
pub use crate::show::{ShowAnswer, ShowView, SHOW_LINE_CAP};
pub use crate::time::{Since, Tz};
pub use crate::why::{Finding, FindingKind, WhyAnswer, WhyArgs, WhyEmpty};

/// A rendered query answer.
pub trait Answer {
    /// Plain text for an agent: dense, aligned, no color, ending with `next:`.
    fn text(&self) -> String;
    /// The same data as JSON, including `searched` and `next`.
    fn json(&self) -> serde_json::Value;
}

/// Errors from the query layer.
#[derive(Debug)]
pub enum QueryError {
    /// A `--since` / `--until` value that can't be read.
    BadTime(String),
    /// Ad-hoc SQL failed; `schema` is the text an agent needs to fix the query.
    Sql {
        message: String,
        schema: String,
    },
    Store(StoreError),
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QueryError::BadTime(m) => write!(f, "{m}"),
            QueryError::Sql { message, schema } => write!(f, "sql error: {message}\n\n{schema}"),
            QueryError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for QueryError {}

impl From<StoreError> for QueryError {
    fn from(e: StoreError) -> Self {
        QueryError::Store(e)
    }
}

/// Entry point for all four calls.
#[derive(Clone)]
pub struct Query {
    reader: Reader,
    host: String,
    tz: Tz,
}

impl Query {
    /// `host` is the machine name printed in `searched:` lines.
    pub fn new(reader: Reader, host: impl Into<String>) -> Self {
        Self {
            reader,
            host: host.into(),
            tz: Tz::Local,
        }
    }

    /// Print and parse wall-clock times in `tz` instead of the local zone.
    pub fn with_tz(mut self, tz: Tz) -> Self {
        self.tz = tz;
        self
    }

    pub fn reader(&self) -> &Reader {
        &self.reader
    }

    pub fn now_ns(&self) -> i64 {
        self.reader.now_ns()
    }

    /// Resolve a `--since` / `--until` value to Unix ns. Git refs need `cwd` (the CLI and
    /// stdio MCP pass the caller's working directory); HTTP passes `None` and gets an error.
    pub fn resolve_since(&self, input: &str, cwd: Option<&Path>) -> Result<i64, QueryError> {
        match time::parse_since(input, self.now_ns(), self.tz)? {
            Since::At(ns) => Ok(ns),
            Since::RunLast => self.last_run_start()?.ok_or_else(|| {
                QueryError::BadTime("run:last: no runs recorded on this host".to_owned())
            }),
            Since::GitRef(rev) => match cwd {
                Some(dir) => time::git_commit_time_ns(dir, &rev),
                None => Err(QueryError::BadTime(format!(
                    "{rev:?} looks like a git ref; over HTTP pass a time (2h, 14:02, RFC 3339) instead"
                ))),
            },
        }
    }

    /// Start of the newest recorded run (`--since run:last`).
    fn last_run_start(&self) -> Result<Option<i64>, QueryError> {
        Ok(data::Ctx::new(self).run(None)?.map(|r| r.ts))
    }

    /// `motel why [service]`.
    pub fn why(&self, args: &WhyArgs) -> Result<WhyAnswer, QueryError> {
        why::why(self, args)
    }

    /// `motel show <id>`; `full` lifts the 200-line cap.
    pub fn show(&self, id: &str, full: bool) -> Result<ShowAnswer, QueryError> {
        show::show(self, id, full)
    }
}
