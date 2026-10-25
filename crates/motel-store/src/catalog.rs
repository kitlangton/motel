use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::schema::read_file_meta;
use crate::StoreError;

pub const NS_PER_SECOND: i64 = 1_000_000_000;
pub const NS_PER_MINUTE: i64 = 60 * NS_PER_SECOND;
pub const NS_PER_HOUR: i64 = 3_600 * NS_PER_SECOND;
pub const NS_PER_DAY: i64 = 86_400 * NS_PER_SECOND;

/// Convert a Unix timestamp in nanoseconds to a UTC `YYYY-MM-DD` string (engine.md §2.4).
pub fn utc_day_string(ts_ns: i64) -> String {
    let days = ts_ns.div_euclid(NS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parse a `YYYY-MM-DD` string back into the UTC start-of-day timestamp in nanoseconds.
pub fn parse_utc_day_start_ns(day: &str) -> Option<i64> {
    if day.len() != 10 {
        return None;
    }
    let bytes = day.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = day[0..4].parse().ok()?;
    let m: u32 = day[5..7].parse().ok()?;
    let d: u32 = day[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d) * NS_PER_DAY)
}

// Howard Hinnant's civil_from_days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

// Howard Hinnant's days_from_civil algorithm.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m_u64 = m as u64;
    let d_u64 = d as u64;
    let doy = (153 * (if m_u64 > 2 { m_u64 - 3 } else { m_u64 + 9 }) + 2) / 5 + d_u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DayFileState {
    Hot,
    Sealing,
    Sealed,
    Evidence,
}

impl DayFileState {
    pub fn is_sealed(self) -> bool {
        matches!(self, DayFileState::Sealed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub day: String,
    pub path: PathBuf,
    pub state: DayFileState,
    pub min_ts: Option<i64>,
    pub max_ts: Option<i64>,
    pub min_ingest_ts: Option<i64>,
    pub max_ingest_ts: Option<i64>,
    pub durable_ingest_ts: Option<i64>,
    pub rows: i64,
}

impl CatalogEntry {
    /// Returns true if this file's recorded `[min_ts, max_ts]` overlaps `[w0, w1]`.
    pub fn overlaps(&self, w0: i64, w1: i64) -> bool {
        let (Some(min_ts), Some(max_ts)) = (self.min_ts, self.max_ts) else {
            return false;
        };
        if self.rows <= 0 {
            return false;
        }
        max_ts >= w0 && min_ts <= w1
    }
}

/// Catalog of day files and `evidence.sqlite` (engine.md §4).
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub days: BTreeMap<String, CatalogEntry>,
    pub evidence: Option<CatalogEntry>,
}

impl Catalog {
    /// Scan `<root>/days/` and `<root>/evidence.sqlite` to build the catalog.
    pub fn scan_dir(root: &Path) -> Result<Self, StoreError> {
        let mut catalog = Catalog::default();
        let days_dir = root.join("days");
        if days_dir.exists() {
            let mut entries: Vec<PathBuf> = fs::read_dir(&days_dir)?
                .filter_map(|e| e.ok().map(|de| de.path()))
                .collect();
            entries.sort();

            for path in entries {
                let Some(fname) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if fname.ends_with(".corrupt.sqlite")
                    || fname.ends_with("-wal")
                    || fname.ends_with("-shm")
                    || fname.ends_with("-journal")
                    || fname.ends_with(".tmp")
                {
                    continue;
                }
                // Phase 2 `.sqlz` files are skipped in Phase 1 (TODO engine.md §2.6).
                if let Some((day, is_hot)) = parse_day_filename(fname) {
                    if let Ok(entry) = inspect_file(&path, &day, is_hot, false) {
                        // Prefer sealed file over hot if both exist transiently.
                        if let Some(existing) = catalog.days.get(&day) {
                            if existing.state == DayFileState::Sealed && is_hot {
                                continue;
                            }
                        }
                        catalog.days.insert(day, entry);
                    }
                }
            }
        }

        let evidence_path = root.join("evidence.sqlite");
        if evidence_path.exists() {
            if let Ok(entry) = inspect_file(&evidence_path, "evidence", true, true) {
                catalog.evidence = Some(entry);
            }
        }

        Ok(catalog)
    }

    /// Return candidate files overlapping `[w0, w1]` ordered by descending `max_ts`
    /// (Astra's merge rule, engine.md §4).
    pub fn candidates_by_max_ts_desc(
        &self,
        w0: i64,
        w1: i64,
        include_evidence: bool,
    ) -> Vec<CatalogEntry> {
        let mut out: Vec<CatalogEntry> = self
            .days
            .values()
            .filter(|e| e.overlaps(w0, w1))
            .cloned()
            .collect();
        if include_evidence {
            if let Some(ev) = &self.evidence {
                if ev.overlaps(w0, w1) {
                    out.push(ev.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            b.max_ts
                .cmp(&a.max_ts)
                .then_with(|| b.day.cmp(&a.day))
        });
        out
    }

    /// Return all non-empty files (for unbounded trace lookup across 14d + evidence)
    /// ordered by descending `max_ts`.
    pub fn all_non_empty_files(&self, include_evidence: bool) -> Vec<CatalogEntry> {
        let mut out: Vec<CatalogEntry> = self
            .days
            .values()
            .filter(|e| e.rows > 0 && e.max_ts.is_some())
            .cloned()
            .collect();
        if include_evidence {
            if let Some(ev) = &self.evidence {
                if ev.rows > 0 && ev.max_ts.is_some() {
                    out.push(ev.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            b.max_ts
                .cmp(&a.max_ts)
                .then_with(|| b.day.cmp(&a.day))
        });
        out
    }

    /// Return candidate files overlapping `[w0, w1]` ordered by descending `max_ingest_ts`
    /// (for newest-arrival-first substring search, engine.md §4).
    pub fn candidates_by_ingest_desc(
        &self,
        w0: i64,
        w1: i64,
        include_evidence: bool,
    ) -> Vec<CatalogEntry> {
        let mut out = self.candidates_by_max_ts_desc(w0, w1, include_evidence);
        out.sort_by(|a, b| {
            b.max_ingest_ts
                .cmp(&a.max_ingest_ts)
                .then_with(|| b.day.cmp(&a.day))
        });
        out
    }

    /// Return the newest `max_ingest_ts` across all files in the catalog (engine.md §4).
    pub fn max_ingest_ts(&self) -> Option<i64> {
        let day_max = self
            .days
            .values()
            .filter_map(|e| e.max_ingest_ts)
            .max();
        let ev_max = self.evidence.as_ref().and_then(|e| e.max_ingest_ts);
        match (day_max, ev_max) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    }
}

/// Parse `<D>.hot.sqlite` -> `Some((D, true))` or `<D>.sqlite` -> `Some((D, false))`.
pub fn parse_day_filename(fname: &str) -> Option<(String, bool)> {
    if let Some(day) = fname.strip_suffix(".hot.sqlite") {
        if parse_utc_day_start_ns(day).is_some() {
            return Some((day.to_owned(), true));
        }
    } else if let Some(day) = fname.strip_suffix(".sqlite") {
        if parse_utc_day_start_ns(day).is_some() {
            return Some((day.to_owned(), false));
        }
    }
    None
}

pub fn inspect_file(
    path: &Path,
    day: &str,
    is_hot_name: bool,
    is_evidence: bool,
) -> Result<CatalogEntry, StoreError> {
    let uri = if !is_hot_name && !is_evidence {
        format!("file:{}?mode=ro&immutable=1", path.display())
    } else {
        format!("file:{}?mode=ro", path.display())
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&uri, flags)?;
    conn.busy_timeout(std::time::Duration::from_millis(1000))?;
    let meta = read_file_meta(&conn)?;
    let state = if is_evidence {
        DayFileState::Evidence
    } else if !is_hot_name {
        DayFileState::Sealed
    } else if meta.state.as_deref() == Some("sealing") {
        DayFileState::Sealing
    } else {
        DayFileState::Hot
    };

    Ok(CatalogEntry {
        day: day.to_owned(),
        path: path.to_path_buf(),
        state,
        min_ts: meta.min_ts,
        max_ts: meta.max_ts,
        min_ingest_ts: meta.min_ingest_ts,
        max_ingest_ts: meta.max_ingest_ts,
        durable_ingest_ts: meta.durable_ingest_ts,
        rows: meta.rows,
    })
}

/// Simple retention unlink: moves sealed day files older than `cutoff_day` (`YYYY-MM-DD`)
/// into `trash/` and unlinks them, removing them from `catalog` (engine.md §1, §2.4).
pub fn unlink_sealed_days_before(
    root: &Path,
    catalog: &RwLock<Catalog>,
    cutoff_day: &str,
) -> Result<Vec<PathBuf>, StoreError> {
    let trash_dir = root.join("trash");
    fs::create_dir_all(&trash_dir)?;

    let to_remove: Vec<(String, PathBuf)> = {
        let guard = catalog.read().unwrap();
        guard
            .days
            .iter()
            .filter(|(d, entry)| d.as_str() < cutoff_day && entry.state == DayFileState::Sealed)
            .map(|(d, entry)| (d.clone(), entry.path.clone()))
            .collect()
    };

    let mut removed = Vec::new();
    for (day, path) in to_remove {
        {
            let mut guard = catalog.write().unwrap();
            guard.days.remove(&day);
        }
        if path.exists() {
            let trash_path = trash_dir.join(
                path.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new("day.sqlite")),
            );
            let _ = fs::rename(&path, &trash_path);
            let _ = fs::remove_file(&trash_path);
            removed.push(path);
        }
    }
    Ok(removed)
}
