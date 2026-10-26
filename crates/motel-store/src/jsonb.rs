use std::collections::HashMap;

use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use xxhash_rust::xxh3::xxh3_128;

use crate::Resource;

// SQLite JSONB element type codes (sqlite3.c JSONB_*).
const JSONB_NULL: u8 = 0;
const JSONB_TRUE: u8 = 1;
const JSONB_FALSE: u8 = 2;
const JSONB_INT: u8 = 3;
const JSONB_INT5: u8 = 4;
const JSONB_FLOAT: u8 = 5;
const JSONB_FLOAT5: u8 = 6;
const JSONB_TEXT: u8 = 7;
const JSONB_TEXTJ: u8 = 8;
const JSONB_TEXT5: u8 = 9;
const JSONB_TEXTRAW: u8 = 10;
const JSONB_ARRAY: u8 = 11;
const JSONB_OBJECT: u8 = 12;

/// Register the `attr(attrs, key)` scalar function on `conn` (engine.md §2.3).
///
/// Works on both SQLite JSONB blobs (`jsonb(?)`) and plain JSON text, and looks up
/// flat keys directly (including dotted keys like `"http.route"`) without requiring
/// JSON-path quoting.
pub fn register_attr_function(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "attr",
        2,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            let key_ref = ctx.get_raw(1);
            let key = match key_ref {
                ValueRef::Text(b) => match std::str::from_utf8(b) {
                    Ok(s) => s,
                    Err(_) => return Ok(Value::Null),
                },
                _ => return Ok(Value::Null),
            };

            match ctx.get_raw(0) {
                ValueRef::Null => Ok(Value::Null),
                ValueRef::Blob(blob) => Ok(extract_from_jsonb_or_text(blob, key)),
                ValueRef::Text(text) => Ok(extract_from_json_text(text, key)),
                _ => Ok(Value::Null),
            }
        },
    )
}

fn decode_jsonb_header(blob: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let first = *blob.get(offset)?;
    let etype = first & 0x0f;
    let sz_code = first >> 4;
    let (hdr_len, payload_len) = match sz_code {
        0..=11 => (1usize, sz_code as usize),
        12 => {
            let n = *blob.get(offset + 1)? as usize;
            (2, n)
        }
        13 => {
            let b0 = *blob.get(offset + 1)?;
            let b1 = *blob.get(offset + 2)?;
            (3, u16::from_be_bytes([b0, b1]) as usize)
        }
        14 => {
            let b = blob.get(offset + 1..offset + 5)?;
            (5, u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
        }
        15 => {
            let b = blob.get(offset + 1..offset + 9)?;
            let n = u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
            (9, usize::try_from(n).ok()?)
        }
        _ => unreachable!(),
    };
    if offset.checked_add(hdr_len)?.checked_add(payload_len)? > blob.len() {
        return None;
    }
    Some((etype, hdr_len, payload_len))
}

/// Extract a flat key from a SQLite JSONB blob (or fallback to text JSON if the blob is UTF-8 JSON).
pub fn extract_from_jsonb_or_text(blob: &[u8], key: &str) -> Value {
    if let Some((etype, hdr_len, payload_len)) = decode_jsonb_header(blob, 0) {
        if etype == JSONB_OBJECT && hdr_len + payload_len == blob.len() {
            let mut pos = hdr_len;
            let end = hdr_len + payload_len;
            while pos < end {
                let Some((k_type, k_hdr, k_len)) = decode_jsonb_header(blob, pos) else {
                    break;
                };
                let k_start = pos + k_hdr;
                let k_end = k_start + k_len;
                let v_pos = k_end;
                let Some((v_type, v_hdr, v_len)) = decode_jsonb_header(blob, v_pos) else {
                    break;
                };
                let v_start = v_pos + v_hdr;
                let v_end = v_start + v_len;

                let key_matches = match k_type {
                    JSONB_TEXT | JSONB_TEXTRAW => &blob[k_start..k_end] == key.as_bytes(),
                    JSONB_TEXTJ | JSONB_TEXT5 => {
                        unescape_json_bytes(&blob[k_start..k_end]).as_deref() == Some(key)
                    }
                    _ => false,
                };

                if key_matches {
                    return decode_jsonb_value(v_type, &blob[v_start..v_end], &blob[v_pos..v_end]);
                }

                pos = v_end;
            }
            return Value::Null;
        }
    }
    extract_from_json_text(blob, key)
}

fn decode_jsonb_value(v_type: u8, payload: &[u8], full_elem: &[u8]) -> Value {
    match v_type {
        JSONB_NULL => Value::Null,
        JSONB_TRUE => Value::Integer(1),
        JSONB_FALSE => Value::Integer(0),
        JSONB_INT | JSONB_INT5 => {
            if let Ok(s) = std::str::from_utf8(payload) {
                if let Ok(i) = s.parse::<i64>() {
                    return Value::Integer(i);
                }
                if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                    if let Ok(i) = i64::from_str_radix(hex, 16) {
                        return Value::Integer(i);
                    }
                }
                if let Ok(f) = s.parse::<f64>() {
                    return Value::Real(f);
                }
            }
            Value::Null
        }
        JSONB_FLOAT | JSONB_FLOAT5 => {
            if let Ok(s) = std::str::from_utf8(payload) {
                if let Ok(f) = s.parse::<f64>() {
                    return Value::Real(f);
                }
            }
            Value::Null
        }
        JSONB_TEXT | JSONB_TEXTRAW => match std::str::from_utf8(payload) {
            Ok(s) => Value::Text(s.to_owned()),
            Err(_) => Value::Null,
        },
        JSONB_TEXTJ | JSONB_TEXT5 => match unescape_json_bytes(payload) {
            Some(s) => Value::Text(s),
            None => Value::Null,
        },
        JSONB_ARRAY | JSONB_OBJECT => Value::Blob(full_elem.to_vec()),
        _ => Value::Null,
    }
}

fn unescape_json_bytes(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?;
    let quoted = format!("\"{s}\"");
    serde_json::from_str::<String>(&quoted).ok()
}

fn extract_from_json_text(bytes: &[u8], key: &str) -> Value {
    let Ok(val) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Value::Null;
    };
    let Some(obj) = val.as_object() else {
        return Value::Null;
    };
    let Some(v) = obj.get(key) else {
        return Value::Null;
    };
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Null
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

/// Maximum nesting depth for JSONB encoding (`docs/engine.md` §2.3, §3.1).
pub const MAX_JSONB_DEPTH: usize = 128;

/// Encode a JSON string directly into `out` in SQLite's binary JSONB format in a single
/// zero-allocation pass (`docs/engine.md` §2.3, sqlite3.c JSONB encoding spec).
///
/// Validates RFC 8259 numbers, string escapes, trailing bytes, and nesting depth (≤ 128).
/// Falls back to `serde_json` for Unicode surrogate pairs or large(>64 KiB) nested containers,
/// and returns `false` (leaving `out` empty) if `json_str` is invalid JSON or exceeds depth 128.
pub fn encode_json_str_to_jsonb_buf(json_str: &str, out: &mut Vec<u8>) -> bool {
    out.clear();
    out.reserve(json_str.len() + 8);
    let bytes = json_str.as_bytes();
    let mut pos = skip_ws(bytes, 0);
    if encode_fast_value(bytes, &mut pos, out, 0) && skip_ws(bytes, pos) == bytes.len() {
        return true;
    }
    out.clear();
    let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) else {
        return false;
    };
    if !encode_json_value_to_jsonb(&val, out, 0) {
        out.clear();
        return false;
    }
    true
}

/// Encode a `serde_json::Value` or JSON string into a freshly allocated JSONB `Vec<u8>`.
pub fn encode_json_str_to_jsonb(json_str: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(json_str.len() + 8);
    if encode_json_str_to_jsonb_buf(json_str, &mut out) {
        Some(out)
    } else {
        None
    }
}

#[inline]
fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn encode_fast_value(b: &[u8], pos: &mut usize, out: &mut Vec<u8>, depth: usize) -> bool {
    if depth > MAX_JSONB_DEPTH {
        return false;
    }
    *pos = skip_ws(b, *pos);
    let Some(&ch) = b.get(*pos) else {
        return false;
    };
    match ch {
        b'{' => encode_fast_object(b, pos, out, depth + 1),
        b'[' => encode_fast_array(b, pos, out, depth + 1),
        b'"' => encode_fast_string(b, pos, out),
        b't' => {
            if b.get(*pos..*pos + 4) == Some(b"true") {
                *pos += 4;
                append_jsonb_header(out, JSONB_TRUE, 0);
                true
            } else {
                false
            }
        }
        b'f' => {
            if b.get(*pos..*pos + 5) == Some(b"false") {
                *pos += 5;
                append_jsonb_header(out, JSONB_FALSE, 0);
                true
            } else {
                false
            }
        }
        b'n' => {
            if b.get(*pos..*pos + 4) == Some(b"null") {
                *pos += 4;
                append_jsonb_header(out, JSONB_NULL, 0);
                true
            } else {
                false
            }
        }
        b'-' | b'0'..=b'9' => encode_fast_number(b, pos, out),
        _ => false,
    }
}

fn encode_fast_object(b: &[u8], pos: &mut usize, out: &mut Vec<u8>, depth: usize) -> bool {
    if depth > MAX_JSONB_DEPTH {
        return false;
    }
    *pos += 1; // skip '{'
    *pos = skip_ws(b, *pos);
    if b.get(*pos) == Some(&b'}') {
        *pos += 1;
        append_jsonb_header(out, JSONB_OBJECT, 0);
        return true;
    }
    // Reserve a 3-byte header (size code 13 = 2-byte big-endian payload size, up to 64 KiB).
    let hdr_idx = out.len();
    out.extend_from_slice(&[(13 << 4) | JSONB_OBJECT, 0, 0]);
    let payload_start = out.len();

    loop {
        *pos = skip_ws(b, *pos);
        if b.get(*pos) != Some(&b'"') {
            return false;
        }
        if !encode_fast_string(b, pos, out) {
            return false;
        }
        *pos = skip_ws(b, *pos);
        if b.get(*pos) != Some(&b':') {
            return false;
        }
        *pos += 1;
        if !encode_fast_value(b, pos, out, depth) {
            return false;
        }
        *pos = skip_ws(b, *pos);
        match b.get(*pos) {
            Some(&b',') => {
                *pos += 1;
            }
            Some(&b'}') => {
                *pos += 1;
                break;
            }
            _ => return false,
        }
    }

    let payload_len = out.len() - payload_start;
    if payload_len > 0xffff {
        return false;
    }
    let len_bytes = (payload_len as u16).to_be_bytes();
    out[hdr_idx + 1] = len_bytes[0];
    out[hdr_idx + 2] = len_bytes[1];
    true
}

fn encode_fast_array(b: &[u8], pos: &mut usize, out: &mut Vec<u8>, depth: usize) -> bool {
    if depth > MAX_JSONB_DEPTH {
        return false;
    }
    *pos += 1; // skip '['
    *pos = skip_ws(b, *pos);
    if b.get(*pos) == Some(&b']') {
        *pos += 1;
        append_jsonb_header(out, JSONB_ARRAY, 0);
        return true;
    }
    let hdr_idx = out.len();
    out.extend_from_slice(&[(13 << 4) | JSONB_ARRAY, 0, 0]);
    let payload_start = out.len();

    loop {
        if !encode_fast_value(b, pos, out, depth) {
            return false;
        }
        *pos = skip_ws(b, *pos);
        match b.get(*pos) {
            Some(&b',') => {
                *pos += 1;
            }
            Some(&b']') => {
                *pos += 1;
                break;
            }
            _ => return false,
        }
    }

    let payload_len = out.len() - payload_start;
    if payload_len > 0xffff {
        return false;
    }
    let len_bytes = (payload_len as u16).to_be_bytes();
    out[hdr_idx + 1] = len_bytes[0];
    out[hdr_idx + 2] = len_bytes[1];
    true
}

fn encode_fast_string(b: &[u8], pos: &mut usize, out: &mut Vec<u8>) -> bool {
    *pos += 1; // skip opening '"'
    let start = *pos;
    let mut has_escape = false;
    let mut i = start;
    while i < b.len() {
        let ch = b[i];
        if ch == b'"' {
            let slice = &b[start..i];
            let etype = if has_escape { JSONB_TEXTJ } else { JSONB_TEXT };
            append_jsonb_header(out, etype, slice.len());
            out.extend_from_slice(slice);
            *pos = i + 1;
            return true;
        }
        if ch == b'\\' {
            has_escape = true;
            let Some(&esc) = b.get(i + 1) else {
                return false;
            };
            match esc {
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                    i += 2;
                }
                b'u' => {
                    let Some(hex) = b.get(i + 2..i + 6) else {
                        return false;
                    };
                    if !hex.iter().all(u8::is_ascii_hexdigit) {
                        return false;
                    }
                    let Ok(hex_str) = std::str::from_utf8(hex) else {
                        return false;
                    };
                    let Ok(code) = u16::from_str_radix(hex_str, 16) else {
                        return false;
                    };
                    // Defer UTF-16 surrogates to the serde_json fallback so unpaired surrogates
                    // are rejected and valid pairs are decoded into UTF-8.
                    if (0xD800..=0xDFFF).contains(&code) {
                        return false;
                    }
                    i += 6;
                }
                _ => return false,
            }
            continue;
        }
        if ch < 0x20 {
            return false;
        }
        i += 1;
    }
    false
}

fn encode_fast_number(b: &[u8], pos: &mut usize, out: &mut Vec<u8>) -> bool {
    let start = *pos;
    let mut i = start;
    let mut is_float = false;

    if b.get(i) == Some(&b'-') {
        i += 1;
    }

    // RFC 8259 integer part: either '0' (not followed by digit) or '1'..'9' followed by *digits.
    match b.get(i) {
        Some(&b'0') => {
            i += 1;
            if matches!(b.get(i), Some(b'0'..=b'9')) {
                return false;
            }
        }
        Some(b'1'..=b'9') => {
            i += 1;
            while matches!(b.get(i), Some(b'0'..=b'9')) {
                i += 1;
            }
        }
        _ => return false,
    }

    // Optional fraction part: '.' followed by 1+ digits.
    if b.get(i) == Some(&b'.') {
        is_float = true;
        i += 1;
        if !matches!(b.get(i), Some(b'0'..=b'9')) {
            return false;
        }
        while matches!(b.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
    }

    // Optional exponent part: ('e' | 'E') ['+' | '-'] 1+ digits.
    if matches!(b.get(i), Some(&b'e') | Some(&b'E')) {
        is_float = true;
        i += 1;
        if matches!(b.get(i), Some(&b'+') | Some(&b'-')) {
            i += 1;
        }
        if !matches!(b.get(i), Some(b'0'..=b'9')) {
            return false;
        }
        while matches!(b.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
    }

    let slice = &b[start..i];
    let Ok(num_str) = std::str::from_utf8(slice) else {
        return false;
    };
    let etype = if is_float {
        let Ok(f) = num_str.parse::<f64>() else {
            return false;
        };
        if !f.is_finite() {
            return false;
        }
        JSONB_FLOAT
    } else if num_str.parse::<i64>().is_ok() {
        JSONB_INT
    } else if num_str.parse::<f64>().is_ok_and(f64::is_finite) {
        JSONB_FLOAT
    } else {
        return false;
    };

    append_jsonb_header(out, etype, slice.len());
    out.extend_from_slice(slice);
    *pos = i;
    true
}

fn append_jsonb_header(out: &mut Vec<u8>, etype: u8, payload_len: usize) {
    if payload_len <= 11 {
        out.push(((payload_len as u8) << 4) | (etype & 0x0f));
    } else if payload_len <= 0xff {
        out.push((12 << 4) | (etype & 0x0f));
        out.push(payload_len as u8);
    } else if payload_len <= 0xffff {
        out.push((13 << 4) | (etype & 0x0f));
        out.extend_from_slice(&(payload_len as u16).to_be_bytes());
    } else {
        out.push((14 << 4) | (etype & 0x0f));
        out.extend_from_slice(&(payload_len as u32).to_be_bytes());
    }
}

fn encode_json_value_to_jsonb(val: &serde_json::Value, out: &mut Vec<u8>, depth: usize) -> bool {
    if depth > MAX_JSONB_DEPTH {
        return false;
    }
    match val {
        serde_json::Value::Null => append_jsonb_header(out, JSONB_NULL, 0),
        serde_json::Value::Bool(true) => append_jsonb_header(out, JSONB_TRUE, 0),
        serde_json::Value::Bool(false) => append_jsonb_header(out, JSONB_FALSE, 0),
        serde_json::Value::Number(n) => {
            let s = n.to_string();
            let etype = if n.is_i64() {
                JSONB_INT
            } else {
                JSONB_FLOAT
            };
            append_jsonb_header(out, etype, s.len());
            out.extend_from_slice(s.as_bytes());
        }
        serde_json::Value::String(s) => {
            append_jsonb_header(out, JSONB_TEXTRAW, s.len());
            out.extend_from_slice(s.as_bytes());
        }
        serde_json::Value::Array(arr) => {
            if depth + 1 > MAX_JSONB_DEPTH {
                return false;
            }
            let mut body = Vec::new();
            for item in arr {
                if !encode_json_value_to_jsonb(item, &mut body, depth + 1) {
                    return false;
                }
            }
            append_jsonb_header(out, JSONB_ARRAY, body.len());
            out.extend_from_slice(&body);
        }
        serde_json::Value::Object(obj) => {
            if depth + 1 > MAX_JSONB_DEPTH {
                return false;
            }
            let mut body = Vec::new();
            for (k, v) in obj {
                append_jsonb_header(&mut body, JSONB_TEXTRAW, k.len());
                body.extend_from_slice(k.as_bytes());
                if !encode_json_value_to_jsonb(v, &mut body, depth + 1) {
                    return false;
                }
            }
            append_jsonb_header(out, JSONB_OBJECT, body.len());
            out.extend_from_slice(&body);
        }
    }
    true
}

impl Resource {
    /// Compute the 128-bit xxh3 canonical hash of this resource without heap allocation (engine.md §2.1, §2.3).
    pub fn canonical_hash(&self) -> [u8; 16] {
        let mut stack_buf = [0u8; 512];
        let mut pos = 0usize;
        let mut push = |bytes: &[u8]| -> bool {
            if pos + bytes.len() <= stack_buf.len() {
                stack_buf[pos..pos + bytes.len()].copy_from_slice(bytes);
                pos += bytes.len();
                true
            } else {
                false
            }
        };

        let fits = (if let Some(h) = &self.host {
            push(b"h:") && push(h.as_bytes())
        } else {
            true
        }) && push(b"|s:")
            && push(self.service.as_bytes())
            && (if let Some(v) = &self.version {
                push(b"|v:") && push(v.as_bytes())
            } else {
                true
            })
            && (if let Some(p) = self.pid {
                push(b"|p:") && push(&p.to_le_bytes())
            } else {
                true
            })
            && (if let Some(a) = &self.attrs {
                push(b"|a:") && push(a.as_bytes())
            } else {
                true
            });

        if fits {
            return xxh3_128(&stack_buf[..pos]).to_be_bytes();
        }

        let mut buf = Vec::with_capacity(256);
        if let Some(h) = &self.host {
            buf.extend_from_slice(b"h:");
            buf.extend_from_slice(h.as_bytes());
        }
        buf.extend_from_slice(b"|s:");
        buf.extend_from_slice(self.service.as_bytes());
        if let Some(v) = &self.version {
            buf.extend_from_slice(b"|v:");
            buf.extend_from_slice(v.as_bytes());
        }
        if let Some(p) = self.pid {
            buf.extend_from_slice(b"|p:");
            buf.extend_from_slice(&p.to_le_bytes());
        }
        if let Some(a) = &self.attrs {
            buf.extend_from_slice(b"|a:");
            buf.extend_from_slice(a.as_bytes());
        }
        xxh3_128(&buf).to_be_bytes()
    }
}

const LRU_NONE: usize = usize::MAX;

struct LruNode {
    key: [u8; 16],
    id: i64,
    prev: usize,
    next: usize,
}

/// O(1) 4,096-entry hash-to-id LRU cache for resource interning per file (`docs/engine.md` §2.3).
pub struct ResourceLru {
    cap: usize,
    head: usize,
    tail: usize,
    nodes: Vec<LruNode>,
    index: HashMap<[u8; 16], usize>,
}

impl ResourceLru {
    pub const DEFAULT_CAPACITY: usize = 4_096;

    pub fn new(cap: usize) -> Self {
        let cap = cap.max(1);
        Self {
            cap,
            head: LRU_NONE,
            tail: LRU_NONE,
            nodes: Vec::with_capacity(cap.min(4_096)),
            index: HashMap::with_capacity(cap.min(4_096)),
        }
    }

    pub fn get(&mut self, hash: &[u8; 16]) -> Option<i64> {
        let &idx = self.index.get(hash)?;
        self.move_to_head(idx);
        Some(self.nodes[idx].id)
    }

    pub fn insert(&mut self, hash: [u8; 16], id: i64) {
        if let Some(&idx) = self.index.get(&hash) {
            self.nodes[idx].id = id;
            self.move_to_head(idx);
            return;
        }

        if self.nodes.len() < self.cap {
            let idx = self.nodes.len();
            self.nodes.push(LruNode {
                key: hash,
                id,
                prev: LRU_NONE,
                next: LRU_NONE,
            });
            self.attach_head(idx);
            self.index.insert(hash, idx);
        } else {
            let evict_idx = self.tail;
            self.unlink(evict_idx);
            let old_key = self.nodes[evict_idx].key;
            self.index.remove(&old_key);
            self.nodes[evict_idx] = LruNode {
                key: hash,
                id,
                prev: LRU_NONE,
                next: LRU_NONE,
            };
            self.attach_head(evict_idx);
            self.index.insert(hash, evict_idx);
        }
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn move_to_head(&mut self, idx: usize) {
        if self.head == idx {
            return;
        }
        self.unlink(idx);
        self.attach_head(idx);
    }

    fn unlink(&mut self, idx: usize) {
        let prev = self.nodes[idx].prev;
        let next = self.nodes[idx].next;
        if prev != LRU_NONE {
            self.nodes[prev].next = next;
        } else {
            self.head = next;
        }
        if next != LRU_NONE {
            self.nodes[next].prev = prev;
        } else {
            self.tail = prev;
        }
        self.nodes[idx].prev = LRU_NONE;
        self.nodes[idx].next = LRU_NONE;
    }

    fn attach_head(&mut self, idx: usize) {
        self.nodes[idx].prev = LRU_NONE;
        self.nodes[idx].next = self.head;
        if self.head != LRU_NONE {
            self.nodes[self.head].prev = idx;
        }
        self.head = idx;
        if self.tail == LRU_NONE {
            self.tail = idx;
        }
    }
}
