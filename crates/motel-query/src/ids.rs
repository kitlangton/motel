//! The ids `show` accepts (api.md §2) and the event id format.
//!
//! Event ids name a row in the store without exposing file names:
//! `e:<YYYYMMDD>.<rowid>` for a row in the day file of UTC arrival day `YYYY-MM-DD`,
//! and `e:ev.<rowid>` for a row in the long-lived evidence store (crashes, runs, failed tests).

/// What an id passed to `show` refers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShowId {
    Trace([u8; 16]),
    Span([u8; 8]),
    Event(EventRef),
    Group(String),
    RunLast,
    Run(i64),
    /// Looked up as a session id, then a request id.
    Other(String),
}

/// A row in one store file.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EventRef {
    /// Catalog day `YYYY-MM-DD`, or `evidence`.
    pub day: String,
    pub row_id: i64,
}

pub const EVIDENCE_DAY: &str = "evidence";

impl EventRef {
    pub fn new(day: &str, row_id: i64) -> Self {
        Self {
            day: day.to_owned(),
            row_id,
        }
    }

    pub fn is_evidence(&self) -> bool {
        self.day == EVIDENCE_DAY
    }

    /// `e:20261025.8812` or `e:ev.12`.
    pub fn id(&self) -> String {
        event_id(&self.day, self.row_id)
    }
}

/// Format the public id of row `row_id` in the file for `day` (`YYYY-MM-DD` or `evidence`).
pub fn event_id(day: &str, row_id: i64) -> String {
    if day == EVIDENCE_DAY {
        format!("e:ev.{row_id}")
    } else {
        format!("e:{}.{row_id}", day.replace('-', ""))
    }
}

/// Classify an id. Never fails: anything unrecognised is [`ShowId::Other`].
pub fn classify(id: &str) -> ShowId {
    let id = id.trim();
    if let Some(rest) = id.strip_prefix("e:") {
        if let Some(r) = parse_event_ref(rest) {
            return ShowId::Event(r);
        }
    }
    if let Some(rest) = id.strip_prefix("g:") {
        if !rest.is_empty() && rest.len() <= 16 && rest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return ShowId::Group(format!("g:{}", rest.to_ascii_lowercase()));
        }
    }
    if id == "run:last" {
        return ShowId::RunLast;
    }
    if let Some(rest) = id.strip_prefix("run:") {
        if let Ok(n) = rest.parse::<i64>() {
            return ShowId::Run(n);
        }
    }
    if id.len() == 32 {
        if let Some(b) = decode_hex::<16>(id) {
            return ShowId::Trace(b);
        }
    }
    if id.len() == 16 {
        if let Some(b) = decode_hex::<8>(id) {
            return ShowId::Span(b);
        }
    }
    ShowId::Other(id.to_owned())
}

fn parse_event_ref(rest: &str) -> Option<EventRef> {
    let (file, row) = rest.split_once('.')?;
    let row_id: i64 = row.parse().ok()?;
    if file == "ev" {
        return Some(EventRef::new(EVIDENCE_DAY, row_id));
    }
    if file.len() != 8 || !file.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let day = format!("{}-{}-{}", &file[0..4], &file[4..6], &file[6..8]);
    motel_store::parse_utc_day_start_ns(&day)?;
    Some(EventRef { day, row_id })
}

pub fn decode_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    let b = s.as_bytes();
    for i in 0..N {
        let hi = (b[2 * i] as char).to_digit(16)?;
        let lo = (b[2 * i + 1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_kind() {
        assert_eq!(
            classify("4bf92f3577b34da6a3ce929d0e0e4736"),
            ShowId::Trace(decode_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap())
        );
        assert_eq!(
            classify("00F067AA0BA902B7"),
            ShowId::Span([0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7])
        );
        assert_eq!(
            classify("e:20261025.8812"),
            ShowId::Event(EventRef::new("2026-10-25", 8812))
        );
        assert_eq!(
            classify("e:ev.12"),
            ShowId::Event(EventRef::new("evidence", 12))
        );
        assert_eq!(
            classify("g:7F3A19C2"),
            ShowId::Group("g:7f3a19c2".to_owned())
        );
        assert_eq!(classify("run:last"), ShowId::RunLast);
        assert_eq!(classify("run:42"), ShowId::Run(42));
        assert_eq!(
            classify("ses_8f2a91c4"),
            ShowId::Other("ses_8f2a91c4".to_owned())
        );
        // Malformed prefixed ids fall through to a session/request lookup.
        assert_eq!(classify("e:2026.1"), ShowId::Other("e:2026.1".to_owned()));
        assert_eq!(
            classify("e:20261399.1"),
            ShowId::Other("e:20261399.1".to_owned())
        );
        assert_eq!(classify("g:xyz"), ShowId::Other("g:xyz".to_owned()));
        assert_eq!(classify("run:abc"), ShowId::Other("run:abc".to_owned()));
        // 32 chars but not hex.
        assert_eq!(
            classify("zzf92f3577b34da6a3ce929d0e0e4736"),
            ShowId::Other("zzf92f3577b34da6a3ce929d0e0e4736".to_owned())
        );
    }

    #[test]
    fn event_ids_round_trip() {
        let r = EventRef::new("2026-10-25", 8812);
        assert_eq!(r.id(), "e:20261025.8812");
        assert_eq!(classify(&r.id()), ShowId::Event(r));
        assert_eq!(event_id("evidence", 3), "e:ev.3");
    }
}
