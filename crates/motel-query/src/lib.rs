//! motel's agent query layer: `why`, `show`, `sql` and `schema` (api.md).
//!
//! Every call returns a typed answer that renders two ways: [`Answer::text`], plain text
//! sized for an agent's context, and [`Answer::json`], the same data plus the `next` list.
//! Each answer says what it searched ([`Searched`]) and ends with 1 to 3 exact follow-up
//! commands.
//!
//! The CLI, HTTP and MCP surfaces all call [`Query`]. Only the CLI and stdio MCP resolve git
//! refs in `--since` ([`Query::resolve_since`] with a `cwd`); HTTP passes `None`.

pub mod fingerprint;
pub mod ids;
#[allow(dead_code)]
mod render;
pub mod time;

use std::fmt;

use motel_store::StoreError;

pub use crate::time::{Since, Tz};

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
