//! Plain-text building blocks shared by every answer.

/// Longest body or message printed in a list row (`docs/agent-api.md` §7).
pub const LIST_BODY_CHARS: usize = 300;

/// One line, whitespace collapsed, newlines shown as `↵`, cut to `max` chars with `…`.
pub fn one_line(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, line) in s
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .enumerate()
    {
        if i > 0 {
            out.push_str(" ↵ ");
        }
        let mut prev_space = false;
        for c in line.chars() {
            if c.is_whitespace() || c.is_control() {
                if !prev_space {
                    out.push(' ');
                }
                prev_space = true;
            } else {
                out.push(c);
                prev_space = false;
            }
        }
        if out.len() > max * 4 {
            break;
        }
    }
    if out.chars().count() > max {
        let cut: String = out.chars().take(max.saturating_sub(1)).collect();
        return format!("{}…", cut.trim_end());
    }
    out
}

/// `1,204`.
pub fn count(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `1 crash`, `3 crashes`.
pub fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", count(n), if n == 1 { one } else { many })
}

pub fn severity_name(sev: Option<i32>) -> &'static str {
    match sev {
        Some(1..=4) => "TRACE",
        Some(5..=8) => "DEBUG",
        Some(9..=12) => "INFO",
        Some(13..=16) => "WARN",
        Some(17..=20) => "ERROR",
        Some(21..=24) => "FATAL",
        _ => "-",
    }
}

/// Align columns; `right[i]` right-aligns column `i`. The last column is never padded.
pub fn table(rows: &[Vec<String>], right: &[bool]) -> Vec<String> {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0usize; cols];
    for r in rows {
        for (i, cell) in r.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    rows.iter()
        .map(|r| {
            let mut line = String::new();
            for (i, cell) in r.iter().enumerate() {
                if i > 0 {
                    line.push_str("  ");
                }
                let pad = widths[i] - cell.chars().count();
                let last = i + 1 == r.len();
                if right.get(i).copied().unwrap_or(false) {
                    line.push_str(&" ".repeat(pad));
                    line.push_str(cell);
                } else {
                    line.push_str(cell);
                    if !last {
                        line.push_str(&" ".repeat(pad));
                    }
                }
            }
            line.trim_end().to_owned()
        })
        .collect()
}

/// Append `searched:` and `next:` to a body.
pub fn finish(mut out: String, searched_line: &str, next: &[String]) -> String {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(searched_line);
    out.push('\n');
    if !next.is_empty() {
        out.push_str("next:\n");
        for n in next {
            out.push_str("  ");
            out.push_str(n);
            out.push('\n');
        }
    }
    out
}

/// Quote a value for a shell command line when needed.
pub fn shell_arg(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '@'))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// Escape a value inside a single-quoted SQL literal.
pub fn sql_str(s: &str) -> String {
    s.replace('\'', "''")
}

/// A `motel sql` command line for `query`. Double quotes when nothing in the query is special
/// inside them (the common case, and easier to read around SQL's single quotes), otherwise
/// single quotes with `'\''` escaping.
pub fn motel_sql(query: &str) -> String {
    if query
        .chars()
        .any(|c| matches!(c, '"' | '$' | '`' | '\\' | '!'))
    {
        format!("motel sql '{}'", query.replace('\'', r"'\''"))
    } else {
        format!("motel sql \"{query}\"")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_cuts_and_flattens() {
        assert_eq!(one_line("a\n  b\tc", 50), "a ↵ b c");
        assert_eq!(one_line("abcdef", 4), "abc…");
        assert_eq!(one_line("abcd", 4), "abcd");
        assert_eq!(one_line("  x  ", 4), "x");
    }

    #[test]
    fn sql_commands_survive_the_shell() {
        assert_eq!(
            motel_sql("select 1 where s = 'a''b'"),
            r#"motel sql "select 1 where s = 'a''b'""#
        );
        assert_eq!(
            motel_sql("select 1 where s = '$(rm -rf ~)\"'"),
            r#"motel sql 'select 1 where s = '\''$(rm -rf ~)"'\'''"#
        );
        assert_eq!(shell_arg("it's"), r"'it'\''s'");
    }

    #[test]
    fn counts_and_tables() {
        assert_eq!(count(1204), "1,204");
        assert_eq!(count(12), "12");
        assert_eq!(count(1_000_000), "1,000,000");
        let rows = vec![
            vec!["1".into(), "ab".into(), "x".into()],
            vec!["10".into(), "a".into(), "yy".into()],
        ];
        assert_eq!(table(&rows, &[true]), vec![" 1  ab  x", "10  a   yy"]);
    }
}
