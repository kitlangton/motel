//! What a call searched (api.md "every response says what it searched").

use std::collections::BTreeSet;

use serde::Serialize;

use crate::data::Ctx;
use crate::ids::EVIDENCE_DAY;
use crate::time::{fmt_age, fmt_minute, fmt_span, iso, Tz};

/// Whether the daemon answered or the caller read the store files itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Live,
    Direct,
}

/// The `searched:` line: window, days, host, live or direct, and staleness.
#[derive(Debug, Clone, Serialize)]
pub struct Searched {
    pub since: String,
    pub until: String,
    /// UTC arrival days whose files were read.
    pub days: Vec<String>,
    /// Whether the long-lived crash/run/test store was read.
    pub evidence: bool,
    pub host: String,
    pub source: Source,
    /// Newest write to the store, if any.
    pub last_write: Option<String>,
    pub staleness_secs: Option<i64>,
    /// True when `why` widened an empty default window.
    pub walked_back: bool,
    pub notes: Vec<String>,
    #[serde(skip)]
    pub(crate) start_ns: i64,
    #[serde(skip)]
    pub(crate) end_ns: i64,
    #[serde(skip)]
    pub(crate) now_ns: i64,
    #[serde(skip)]
    pub(crate) last_write_ns: Option<i64>,
    #[serde(skip)]
    pub(crate) tz: Tz,
}

/// Files touched while answering one call.
#[derive(Debug, Default, Clone)]
pub(crate) struct Visited(pub BTreeSet<String>);

impl Visited {
    pub fn add(&mut self, day: &str) {
        if !self.0.contains(day) {
            self.0.insert(day.to_owned());
        }
    }
}

impl Ctx<'_> {
    pub(crate) fn searched(&self, start_ns: i64, end_ns: i64) -> Searched {
        let now_ns = self.now;
        let last_write_ns = self.snap.max_ingest_ts();
        let visited = self.visited.borrow();
        let days: Vec<String> = visited
            .0
            .iter()
            .filter(|d| d.as_str() != EVIDENCE_DAY)
            .cloned()
            .collect();
        Searched {
            since: iso(start_ns),
            until: iso(end_ns),
            days,
            evidence: visited.0.contains(EVIDENCE_DAY),
            host: self.q.host.clone(),
            source: if self.q.reader.is_direct() {
                Source::Direct
            } else {
                Source::Live
            },
            last_write: last_write_ns.map(iso),
            staleness_secs: last_write_ns.map(|w| (now_ns - w).max(0) / 1_000_000_000),
            walked_back: false,
            notes: Vec::new(),
            start_ns,
            end_ns,
            now_ns,
            last_write_ns,
            tz: self.tz,
        }
    }
}

impl Searched {
    /// The window alone: `last 24h (since Oct 24 15:00)` or `13:00 → 14:00 (1h)`.
    pub fn window_text(&self) -> String {
        let span = fmt_span(self.end_ns - self.start_ns);
        let from = fmt_minute(self.start_ns, self.now_ns, self.tz);
        if (self.now_ns - self.end_ns).abs() < 1_000_000_000 {
            format!("last {span} (since {from})")
        } else {
            let to = fmt_minute(self.end_ns, self.now_ns, self.tz);
            format!("{from} → {to} ({span})")
        }
    }

    pub fn line(&self) -> String {
        let mut parts = vec![self.window_text()];
        let days = match self.days.len() {
            0 => "no day files".to_owned(),
            1 => format!("day {}", self.days[0]),
            2 | 3 => format!("days {}", self.days.join(", ")),
            n => format!(
                "{n} days {} → {}",
                self.days.first().unwrap(),
                self.days.last().unwrap()
            ),
        };
        parts.push(if self.evidence {
            format!("{days} + evidence")
        } else {
            days
        });
        parts.push(format!("host {}", self.host));
        parts.push(
            match self.source {
                Source::Live => "via daemon",
                Source::Direct => "read files directly",
            }
            .to_owned(),
        );
        parts.push(match self.last_write_ns {
            Some(w) => format!("last write {} ago", fmt_age(self.now_ns - w)),
            None => "store empty".to_owned(),
        });
        let mut line = format!("searched: {}", parts.join(" · "));
        for note in &self.notes {
            line.push_str("\nnote: ");
            line.push_str(note);
        }
        line
    }
}
