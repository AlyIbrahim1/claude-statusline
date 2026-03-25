use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Strips ANSI escape sequences matching \x1b\[[0-9;]*[mGKHFABCDJ]
/// Applied to user-supplied strings (model name, task, dirname, branch).
fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            while chars.peek().map_or(false, |c| c.is_ascii_digit() || *c == ';') {
                chars.next();
            }
            if chars.peek().map_or(false, |c| "mGKHFABCDJ".contains(*c)) {
                chars.next(); // consume terminator — discard sequence
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Strips only \x1b\[[0-9;]*m sequences (SGR only).
/// Non-m escape sequences are preserved and count toward length.
fn strip_sgr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            let mut seq = String::from("\x1b[");
            chars.next(); // consume '['
            while chars.peek().map_or(false, |c| c.is_ascii_digit() || *c == ';') {
                seq.push(chars.next().unwrap());
            }
            if chars.peek() == Some(&'m') {
                chars.next(); // consume 'm' — discard SGR sequence
            } else {
                out.push_str(&seq); // not SGR — keep it
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Counts visible characters after stripping SGR sequences.
/// Characters above U+FFFF count as 2 to match JS .length (surrogate pair) behaviour.
fn visible_len(s: &str) -> usize {
    strip_sgr(s).chars().map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 }).sum()
}

fn main() {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).ok();
        tx.send(input).ok();
    });
    let input = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(s) => s,
        Err(_) => return,
    };
    if let Some(out) = render(&input) {
        print!("{}", out);
    }
}

fn render(_input: &str) -> Option<String> {
    Some(String::from("placeholder"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_ansi_m_codes() {
        assert_eq!(sanitize("\x1b[32mhello\x1b[0m"), "hello");
    }

    #[test]
    fn sanitize_strips_cursor_codes() {
        assert_eq!(sanitize("\x1b[2Jclear\x1b[H"), "clear");
    }

    #[test]
    fn sanitize_preserves_non_ansi() {
        assert_eq!(sanitize("hello world"), "hello world");
    }

    #[test]
    fn sanitize_preserves_utf8() {
        assert_eq!(sanitize("💀 bar"), "💀 bar");
    }

    #[test]
    fn visible_len_strips_only_m_codes() {
        let s = "\x1b[32mhello\x1b[0m";
        assert_eq!(visible_len(s), 5);
    }

    #[test]
    fn visible_len_keeps_non_m_escapes() {
        // \x1b[2J is NOT an SGR (m) code — it stays and counts toward length
        let s = "\x1b[2Jabc";
        assert_eq!(visible_len(s), s.chars().count());
    }

    #[test]
    fn visible_len_counts_emoji_as_two() {
        // 💀 is above U+FFFF — counts as 2 to match JS .length (surrogate pair)
        assert_eq!(visible_len("💀"), 2);
    }
}
