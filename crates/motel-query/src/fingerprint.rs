//! Error-group fingerprints, computed at query time (api.md §1).
//!
//! A group is service + kind + name + normalized message. Normalization masks the parts of
//! a message that vary between occurrences of the same error: quoted values, UUIDs, file
//! paths, hex runs and numbers. The group id is `g:` plus the first 8 hex digits of the
//! xxh3-64 of the fingerprint, so it is stable across queries, processes and machines.

use xxhash_rust::xxh3::xxh3_64;

/// Raw message bytes considered before normalizing.
const RAW_CAP: usize = 512;
/// Normalized message length kept in the fingerprint.
const NORM_CAP: usize = 200;

/// The first non-empty line of a message, normalized.
pub fn normalize(message: &str) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let line = cut_bytes(line, RAW_CAP);
    let masked = mask_tokens(line);
    let mut out = String::with_capacity(masked.len());
    // Collapse whitespace so reflowed messages group together.
    let mut prev_space = false;
    for c in masked.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    let out = out.trim().to_owned();
    cut_bytes(&out, NORM_CAP).to_owned()
}

/// The fingerprint key for an error event.
pub fn fingerprint(service: &str, kind: &str, name: Option<&str>, message: &str) -> u64 {
    let norm = normalize(message);
    let key = format!(
        "{service}\u{1f}{kind}\u{1f}{}\u{1f}{norm}",
        name.unwrap_or("")
    );
    xxh3_64(key.as_bytes())
}

/// `g:` + first 8 hex digits of the fingerprint.
pub fn group_id(fp: u64) -> String {
    format!("g:{:08x}", fp >> 32)
}

fn cut_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Mask quoted strings first (they may contain anything), then each whitespace token.
fn mask_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut token = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if matches!(c, '"' | '\'' | '`') {
            // An apostrophe inside a word ("can't") is not a quote.
            let in_word = c == '\'' && token.chars().last().is_some_and(char::is_alphanumeric);
            if !in_word {
                let rest: String = chars.clone().collect();
                if let Some(close) = rest.find(c) {
                    flush_token(&mut token, &mut out);
                    out.push_str("<str>");
                    for _ in 0..rest[..close].chars().count() + 1 {
                        chars.next();
                    }
                    continue;
                }
            }
        }
        if c.is_whitespace() {
            flush_token(&mut token, &mut out);
            out.push(c);
        } else {
            token.push(c);
        }
    }
    flush_token(&mut token, &mut out);
    out
}

fn flush_token(token: &mut String, out: &mut String) {
    if token.is_empty() {
        return;
    }
    // Keep leading and trailing punctuation outside the mask: `(/tmp/a.txt),` → `(<path>),`.
    let core_start = token
        .find(|c: char| c.is_alphanumeric() || matches!(c, '/' | '~' | '.' | '\\' | '-' | '_'))
        .unwrap_or(token.len());
    let core_end = token
        .rfind(|c: char| c.is_alphanumeric() || matches!(c, '/' | '_'))
        .map(|i| i + token[i..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(core_start)
        .max(core_start);
    let (pre, core, post) = (
        &token[..core_start],
        &token[core_start..core_end],
        &token[core_end..],
    );
    out.push_str(pre);
    if is_path(core) {
        out.push_str("<path>");
    } else {
        mask_inline(core, out);
    }
    out.push_str(post);
    token.clear();
}

fn is_path(t: &str) -> bool {
    let rooted = t.starts_with('/')
        || t.starts_with("~/")
        || t.starts_with("./")
        || t.starts_with("../")
        || t.contains("://")
        || (t.len() > 2 && t.as_bytes()[1] == b':' && t.as_bytes()[2] == b'\\');
    if !rooted {
        return false;
    }
    let seps = t.matches(['/', '\\']).count();
    let last = t.rsplit(['/', '\\']).next().unwrap_or("");
    // `file.ts:42:17` → `file.ts`.
    let last = last.trim_end_matches(|c: char| c.is_ascii_digit() || c == ':');
    let has_ext = last
        .rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && !ext.is_empty() && ext.len() <= 5);
    seps >= 3 || has_ext || t.contains("://")
}

/// Within one token: UUIDs, `0x` and long hex runs, then digit runs.
fn mask_inline(t: &str, out: &mut String) {
    let b = t.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if let Some(n) = uuid_at(b, i) {
            out.push_str("<uuid>");
            i += n;
            continue;
        }
        let word_start = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if word_start
            && b[i] == b'0'
            && i + 2 < b.len()
            && (b[i + 1] == b'x' || b[i + 1] == b'X')
            && b[i + 2].is_ascii_hexdigit()
        {
            let mut j = i + 2;
            while j < b.len() && b[j].is_ascii_hexdigit() {
                j += 1;
            }
            out.push_str("<hex>");
            i = j;
            continue;
        }
        if b[i].is_ascii_hexdigit() && word_start {
            let mut j = i;
            let mut digits = 0;
            while j < b.len() && b[j].is_ascii_hexdigit() {
                if b[j].is_ascii_digit() {
                    digits += 1;
                }
                j += 1;
            }
            let word_end = j == b.len() || !b[j].is_ascii_alphanumeric();
            if word_end && j - i >= 6 && digits > 0 && digits < j - i {
                out.push_str("<hex>");
                i = j;
                continue;
            }
        }
        if b[i].is_ascii_digit() {
            let mut j = i;
            while j < b.len()
                && (b[j].is_ascii_digit()
                    || (b[j] == b'.' && j + 1 < b.len() && b[j + 1].is_ascii_digit()))
            {
                j += 1;
            }
            out.push_str("<n>");
            i = j;
            continue;
        }
        let ch = t[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
}

fn uuid_at(b: &[u8], i: usize) -> Option<usize> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut j = i;
    for (g, len) in GROUPS.iter().enumerate() {
        for _ in 0..*len {
            if j >= b.len() || !b[j].is_ascii_hexdigit() {
                return None;
            }
            j += 1;
        }
        if g < 4 {
            if j >= b.len() || b[j] != b'-' {
                return None;
            }
            j += 1;
        }
    }
    Some(j - i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_variable_parts() {
        assert_eq!(
            normalize("upstream timeout after 30000ms (attempt 3)"),
            "upstream timeout after <n>ms (attempt <n>)"
        );
        assert_eq!(
            normalize("user 550e8400-e29b-41d4-a716-446655440000 not found"),
            "user <uuid> not found"
        );
        assert_eq!(
            normalize("failed to open /Users/someone/proj/config.toml: denied"),
            "failed to open <path>: denied"
        );
        assert_eq!(
            normalize("bad key \"abc def\" in 'x'"),
            "bad key <str> in <str>"
        );
        assert_eq!(
            normalize("ptr 0x7ffee3b0 deadbeef01 ok"),
            "ptr <hex> <hex> ok"
        );
        assert_eq!(
            normalize("can't connect id=a1b2c3d4"),
            "can't connect id=<hex>"
        );
        assert_eq!(normalize("GET /users/42 failed"), "GET /users/<n> failed");
        assert_eq!(normalize("at /app/main.ts:42:17"), "at <path>");
        assert_eq!(normalize("line one\nline two"), "line one");
        assert_eq!(normalize("  spaced   out  "), "spaced out");
        // Plain words made of hex letters stay.
        assert_eq!(normalize("decade facade accede"), "decade facade accede");
    }

    #[test]
    fn group_ids_are_stable() {
        let a = fingerprint(
            "api",
            "log",
            Some("log"),
            "timeout after 30000ms id=ab12cd34ef",
        );
        let b = fingerprint(
            "api",
            "log",
            Some("log"),
            "timeout after 120ms id=99ffee0011",
        );
        assert_eq!(a, b);
        assert_ne!(
            a,
            fingerprint(
                "worker",
                "log",
                Some("log"),
                "timeout after 1ms id=ab12cd34ef"
            )
        );
        assert_ne!(
            a,
            fingerprint(
                "api",
                "span",
                Some("log"),
                "timeout after 1ms id=ab12cd34ef"
            )
        );
        // Pinned so ids in old transcripts keep resolving.
        assert_eq!(
            group_id(fingerprint("api", "log", Some("log"), "boom")),
            group_id(xxh3_64(b"api\x1flog\x1flog\x1fboom"))
        );
        assert_eq!(group_id(0x7f3a_19c2_0000_0001), "g:7f3a19c2");
    }
}
