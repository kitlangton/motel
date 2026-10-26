//! Time zones, human formatting, and `--since` parsing (api.md §3).

use std::path::Path;
use std::process::Command;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use motel_store::{NS_PER_DAY, NS_PER_HOUR, NS_PER_MINUTE, NS_PER_SECOND};

use crate::QueryError;

/// Time zone used to read `HH:MM` and to print times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tz {
    /// The machine's local zone, including DST.
    #[default]
    Local,
    /// A fixed offset in seconds east of UTC (tests use `Fixed(0)`).
    Fixed(i32),
}

impl Tz {
    fn offset_secs(self, ts_ns: i64) -> i64 {
        match self {
            Tz::Fixed(s) => s as i64,
            Tz::Local => Local.timestamp_nanos(ts_ns).offset().local_minus_utc() as i64,
        }
    }

    /// Wall-clock date and time for `ts_ns` in this zone.
    pub fn wall(self, ts_ns: i64) -> NaiveDateTime {
        let shifted = ts_ns.saturating_add(self.offset_secs(ts_ns) * NS_PER_SECOND);
        DateTime::from_timestamp_nanos(shifted).naive_utc()
    }

    /// Unix ns for a wall-clock time in this zone (earliest match across DST folds).
    pub fn from_wall(self, wall: NaiveDateTime) -> Option<i64> {
        match self {
            Tz::Fixed(s) => wall
                .and_utc()
                .timestamp_nanos_opt()
                .map(|ns| ns - s as i64 * NS_PER_SECOND),
            Tz::Local => Local
                .from_local_datetime(&wall)
                .earliest()
                .and_then(|dt| dt.timestamp_nanos_opt()),
        }
    }
}

/// `14:02:11` today, `Oct 24 14:02:11` this year, `2025-10-24 14:02:11` otherwise.
pub fn fmt_time(ts_ns: i64, now_ns: i64, tz: Tz) -> String {
    let t = tz.wall(ts_ns);
    let n = tz.wall(now_ns);
    if t.date() == n.date() {
        t.format("%H:%M:%S").to_string()
    } else if t.year() == n.year() {
        t.format("%b %d %H:%M:%S").to_string()
    } else {
        t.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

/// Like [`fmt_time`] with milliseconds, for single-event views.
pub fn fmt_time_ms(ts_ns: i64, now_ns: i64, tz: Tz) -> String {
    let base = fmt_time(ts_ns, now_ns, tz);
    let ms = tz.wall(ts_ns).nanosecond() / 1_000_000;
    format!("{base}.{ms:03}")
}

/// Minute precision: `14:02`, `Oct 24 14:02`, `2025-10-24 14:02`.
pub fn fmt_minute(ts_ns: i64, now_ns: i64, tz: Tz) -> String {
    let t = tz.wall(ts_ns);
    let n = tz.wall(now_ns);
    if t.date() == n.date() {
        t.format("%H:%M").to_string()
    } else if t.year() == n.year() {
        t.format("%b %d %H:%M").to_string()
    } else {
        t.format("%Y-%m-%d %H:%M").to_string()
    }
}

/// `first → last`, dropping the date from `last` when both fall on the same day.
pub fn fmt_range(first_ns: i64, last_ns: i64, now_ns: i64, tz: Tz) -> String {
    if first_ns == last_ns {
        return fmt_time(first_ns, now_ns, tz);
    }
    let a = fmt_time(first_ns, now_ns, tz);
    let b = if tz.wall(first_ns).date() == tz.wall(last_ns).date() {
        tz.wall(last_ns).format("%H:%M:%S").to_string()
    } else {
        fmt_time(last_ns, now_ns, tz)
    };
    format!("{a} → {b}")
}

/// UTC RFC 3339 with milliseconds, for JSON.
pub fn iso(ts_ns: i64) -> String {
    DateTime::from_timestamp_nanos(ts_ns)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `850µs`, `340ms`, `12.1s`, `3m12s`, `2h05m`, `3d4h`.
pub fn fmt_dur(ns: i64) -> String {
    let ns = ns.max(0);
    if ns < 1_000_000 {
        let us = ns / 1_000;
        return format!("{us}µs");
    }
    if ns < NS_PER_SECOND {
        return format!("{}ms", ns / 1_000_000);
    }
    if ns < NS_PER_MINUTE {
        let tenths = (ns + 50_000_000) / 100_000_000;
        if tenths >= 600 {
            return "1m00s".to_owned();
        }
        return format!("{}.{}s", tenths / 10, tenths % 10);
    }
    if ns < NS_PER_HOUR {
        let s = ns / NS_PER_SECOND;
        return format!("{}m{:02}s", s / 60, s % 60);
    }
    if ns < NS_PER_DAY {
        let m = ns / NS_PER_MINUTE;
        return format!("{}h{:02}m", m / 60, m % 60);
    }
    let h = ns / NS_PER_HOUR;
    if h % 24 == 0 {
        format!("{}d", h / 24)
    } else {
        format!("{}d{}h", h / 24, h % 24)
    }
}

/// Coarse age: `3s`, `5m`, `2h`, `3d`.
pub fn fmt_age(ns: i64) -> String {
    let ns = ns.max(0);
    if ns < NS_PER_MINUTE {
        format!("{}s", ns / NS_PER_SECOND)
    } else if ns < NS_PER_HOUR {
        format!("{}m", ns / NS_PER_MINUTE)
    } else if ns < NS_PER_DAY {
        format!("{}h", ns / NS_PER_HOUR)
    } else {
        format!("{}d", ns / NS_PER_DAY)
    }
}

/// Window length in the `24h` / `3d` / `90m` shorthand.
pub fn fmt_span(ns: i64) -> String {
    if ns >= 2 * NS_PER_DAY && ns % NS_PER_DAY == 0 {
        format!("{}d", ns / NS_PER_DAY)
    } else if ns > 0 && ns % NS_PER_HOUR == 0 {
        format!("{}h", ns / NS_PER_HOUR)
    } else if ns >= NS_PER_HOUR {
        fmt_dur(ns)
    } else {
        format!("{}m", (ns + NS_PER_MINUTE - 1) / NS_PER_MINUTE)
    }
}

/// A `--since` / `--until` value before resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Since {
    /// An absolute time in Unix ns.
    At(i64),
    /// A git revision, resolved to its commit time by the CLI and stdio MCP.
    GitRef(String),
    /// The start of the most recent run.
    RunLast,
}

/// Parse `2h`, `30m`, `1h30m`, `7d`, `14:02` (today, local), `2026-10-25`, an RFC 3339 time,
/// `run:last`, or anything else that could be a git revision.
pub fn parse_since(input: &str, now_ns: i64, tz: Tz) -> Result<Since, QueryError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(QueryError::BadTime("empty time".to_owned()));
    }
    if s == "run:last" {
        return Ok(Since::RunLast);
    }
    if let Some(ns) = parse_duration_ns(s) {
        return Ok(Since::At(now_ns.saturating_sub(ns)));
    }
    if let Some(ts) = parse_clock_today(s, now_ns, tz) {
        return Ok(Since::At(ts));
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        if let Some(ns) = dt.timestamp_nanos_opt() {
            return Ok(Since::At(ns));
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        if let Some(ns) = tz.from_wall(date.and_time(NaiveTime::MIN)) {
            return Ok(Since::At(ns));
        }
    }
    if looks_like_git_ref(s) {
        return Ok(Since::GitRef(s.to_owned()));
    }
    Err(QueryError::BadTime(format!(
        "can't read {s:?} as a time: use 2h, 30m, 14:02, an RFC 3339 time, a git ref or run:last"
    )))
}

/// Parse `90s`, `30m`, `2h`, `7d`, `1w`, `500ms` and sums like `1h30m`.
pub fn parse_duration_ns(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut total: i64 = 0;
    let mut any = false;
    while i < b.len() {
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        if start == i {
            return None;
        }
        let num: f64 = s[start..i].parse().ok()?;
        let unit_start = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let unit = match &s[unit_start..i] {
            "ms" => 1_000_000,
            "s" | "sec" => NS_PER_SECOND,
            "m" | "min" => NS_PER_MINUTE,
            "h" | "hr" => NS_PER_HOUR,
            "d" => NS_PER_DAY,
            "w" => 7 * NS_PER_DAY,
            _ => return None,
        };
        total = total.checked_add((num * unit as f64) as i64)?;
        any = true;
    }
    any.then_some(total)
}

fn parse_clock_today(s: &str, now_ns: i64, tz: Tz) -> Option<i64> {
    let time = NaiveTime::parse_from_str(s, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(s, "%H:%M:%S"))
        .ok()?;
    let today = tz.wall(now_ns).date();
    let ts = tz.from_wall(today.and_time(time))?;
    // A clock time later than now means the same time yesterday.
    if ts > now_ns {
        tz.from_wall(today.pred_opt()?.and_time(time))
    } else {
        Some(ts)
    }
}

fn looks_like_git_ref(s: &str) -> bool {
    !s.starts_with('-')
        && s.len() <= 200
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '/' | '.' | '_' | '-' | '~' | '^' | '@' | '{' | '}')
        })
}

/// Commit time of `rev` in the git repository at `cwd` (`git log -1 --format=%ct <rev>`).
pub fn git_commit_time_ns(cwd: &Path, rev: &str) -> Result<i64, QueryError> {
    if !looks_like_git_ref(rev) {
        return Err(QueryError::BadTime(format!(
            "{rev:?} is not a git revision"
        )));
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["log", "-1", "--format=%ct", rev, "--"])
        .output()
        .map_err(|e| QueryError::BadTime(format!("can't run git to resolve {rev:?}: {e}")))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let first = msg.lines().next().unwrap_or("").trim();
        return Err(QueryError::BadTime(format!(
            "can't resolve {rev:?} as a time or git ref in {}: {first}",
            cwd.display()
        )));
    }
    let secs: i64 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| QueryError::BadTime(format!("git gave no commit time for {rev:?}")))?;
    Ok(secs * NS_PER_SECOND)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_792_940_400 * NS_PER_SECOND; // 2026-10-25T15:00:00Z

    #[test]
    fn durations() {
        assert_eq!(parse_duration_ns("2h"), Some(2 * NS_PER_HOUR));
        assert_eq!(parse_duration_ns("30m"), Some(30 * NS_PER_MINUTE));
        assert_eq!(parse_duration_ns("1h30m"), Some(90 * NS_PER_MINUTE));
        assert_eq!(parse_duration_ns("500ms"), Some(500_000_000));
        assert_eq!(parse_duration_ns("7d"), Some(7 * NS_PER_DAY));
        assert_eq!(parse_duration_ns("HEAD"), None);
        assert_eq!(parse_duration_ns("2x"), None);
        assert_eq!(parse_duration_ns(""), None);
    }

    #[test]
    fn since_forms() {
        let tz = Tz::Fixed(0);
        assert_eq!(
            parse_since("2h", NOW, tz).unwrap(),
            Since::At(NOW - 2 * NS_PER_HOUR)
        );
        assert_eq!(
            parse_since("14:02", NOW, tz).unwrap(),
            Since::At(NOW - 58 * NS_PER_MINUTE)
        );
        // Later than now today: the same clock time yesterday.
        assert_eq!(
            parse_since("16:00", NOW, tz).unwrap(),
            Since::At(NOW + NS_PER_HOUR - NS_PER_DAY)
        );
        assert_eq!(
            parse_since("2026-10-25T13:00:00Z", NOW, tz).unwrap(),
            Since::At(NOW - 2 * NS_PER_HOUR)
        );
        assert_eq!(
            parse_since("2026-10-25T15:00:00+02:00", NOW, tz).unwrap(),
            Since::At(NOW - 2 * NS_PER_HOUR)
        );
        assert_eq!(
            parse_since("2026-10-25", NOW, tz).unwrap(),
            Since::At(NOW - 15 * NS_PER_HOUR)
        );
        assert_eq!(parse_since("run:last", NOW, tz).unwrap(), Since::RunLast);
        assert_eq!(
            parse_since("HEAD~1", NOW, tz).unwrap(),
            Since::GitRef("HEAD~1".to_owned())
        );
        assert!(parse_since("--exec=rm", NOW, tz).is_err());
        assert!(parse_since("two hours", NOW, tz).is_err());
    }

    #[test]
    fn local_offset_clock_time() {
        // 14:02 at UTC+2 is 12:02Z.
        let tz = Tz::Fixed(2 * 3600);
        assert_eq!(
            parse_since("14:02", NOW, tz).unwrap(),
            Since::At(NOW - 2 * NS_PER_HOUR - 58 * NS_PER_MINUTE)
        );
    }

    #[test]
    fn formatting() {
        assert_eq!(fmt_dur(850_000), "850µs");
        assert_eq!(fmt_dur(340_000_000), "340ms");
        assert_eq!(fmt_dur(12_100_000_000), "12.1s");
        assert_eq!(fmt_dur(59_990_000_000), "1m00s");
        assert_eq!(fmt_dur(192 * NS_PER_SECOND), "3m12s");
        assert_eq!(fmt_dur(125 * NS_PER_MINUTE), "2h05m");
        let tz = Tz::Fixed(0);
        assert_eq!(fmt_time(NOW - NS_PER_HOUR, NOW, tz), "14:00:00");
        assert_eq!(fmt_time(NOW - NS_PER_DAY, NOW, tz), "Oct 24 15:00:00");
        assert_eq!(
            fmt_time(NOW - 400 * NS_PER_DAY, NOW, tz),
            "2025-09-20 15:00:00"
        );
        assert_eq!(
            fmt_range(NOW - 2 * NS_PER_HOUR, NOW - NS_PER_HOUR, NOW, tz),
            "13:00:00 → 14:00:00"
        );
        assert_eq!(iso(NOW), "2026-10-25T15:00:00.000Z");
        assert_eq!(fmt_span(24 * NS_PER_HOUR), "24h");
        assert_eq!(fmt_span(3 * NS_PER_DAY), "3d");
        assert_eq!(fmt_span(2 * NS_PER_HOUR), "2h");
    }
}
