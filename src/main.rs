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

/// Builds the ANSI context usage bar. `remaining` is remaining_percentage from stdin.
fn context_bar(remaining: f64) -> String {
    const AUTO_COMPACT_BUFFER_PCT: f64 = 16.5;
    let usable_remaining = f64::max(
        0.0,
        ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100.0 - AUTO_COMPACT_BUFFER_PCT)) * 100.0,
    );
    let used = f64::max(0.0, f64::min(100.0, (100.0 - usable_remaining).round())) as u8;
    let filled = (used / 10) as usize;
    let bar = format!("{}{}", "█".repeat(filled), "░".repeat(10 - filled));
    if used < 50 {
        format!(" \x1b[32m{} {}%\x1b[0m", bar, used)
    } else if used < 65 {
        format!(" \x1b[33m{} {}%\x1b[0m", bar, used)
    } else if used < 80 {
        format!(" \x1b[38;5;208m{} {}%\x1b[0m", bar, used)
    } else {
        format!(" \x1b[5;31m💀 {} {}%\x1b[0m", bar, used)
    }
}

fn usage_line(label: &str, pct: f64, suffix: &str) -> String {
    let p = pct.round() as i64;
    let color = if p < 50 { "\x1b[32m" } else if p < 75 { "\x1b[33m" } else { "\x1b[31m" };
    format!("\x1b[0m\x1b[97m{}:\x1b[0m {}{}%\x1b[0m{}", label, color, p, suffix)
}

fn reset_suffix(resets_at: i64) -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let reset_ms = resets_at * 1000;
    let mins_left = i64::max(0, ((reset_ms - now_ms) as f64 / 60_000.0).round() as i64);
    let h = mins_left / 60;
    let m = mins_left % 60;
    format!(" \x1b[2m↺ {}h{:02}m\x1b[0m", h, m)
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

    #[test]
    fn context_bar_green_below_50() {
        // remaining=80 → usable_remaining = (80-16.5)/83.5*100 = 75.99 → used = round(24.01) = 24
        let bar = context_bar(80.0);
        assert!(bar.contains("\x1b[32m"), "expected green for used=24");
    }

    #[test]
    fn context_bar_yellow_50_to_64() {
        // used=50 → usable_remaining=50 → remaining = 50*83.5/100 + 16.5 = 58.25
        let bar = context_bar(58.25);
        assert!(bar.contains("\x1b[33m"), "expected yellow for used=50");
    }

    #[test]
    fn context_bar_orange_65_to_79() {
        // used=65 → usable_remaining=35 → remaining = 35*83.5/100 + 16.5 = 45.725
        let bar = context_bar(45.725);
        assert!(bar.contains("\x1b[38;5;208m"), "expected orange for used=65");
    }

    #[test]
    fn context_bar_red_skull_at_80_plus() {
        // used=80 → usable_remaining=20 → remaining = 20*83.5/100 + 16.5 = 33.2
        let bar = context_bar(33.2);
        assert!(bar.contains("\x1b[5;31m"), "expected blinking red for used=80");
        assert!(bar.contains("💀"));
    }

    #[test]
    fn context_bar_full_at_zero_remaining() {
        let bar = context_bar(0.0);
        assert!(bar.contains("██████████"), "expected 10 filled segments");
        assert!(bar.contains("100%"));
    }

    #[test]
    fn context_bar_empty_at_full_remaining() {
        let bar = context_bar(100.0);
        assert!(bar.contains("░░░░░░░░░░"), "expected 10 empty segments");
        assert!(bar.contains("0%"));
    }

    #[test]
    fn context_bar_has_10_segments() {
        let bar = context_bar(50.0);
        let stripped = sanitize(&bar);
        let filled = stripped.matches('█').count();
        let empty = stripped.matches('░').count();
        assert_eq!(filled + empty, 10);
    }

    #[test]
    fn usage_line_green_below_50() {
        let line = usage_line("Current", 49.0, "");
        assert!(line.contains("\x1b[32m"));
        assert!(line.contains("49%"));
        assert!(line.contains("Current:"));
    }

    #[test]
    fn usage_line_yellow_50_to_74() {
        let line = usage_line("Weekly", 74.0, "");
        assert!(line.contains("\x1b[33m"));
    }

    #[test]
    fn usage_line_red_at_75_plus() {
        let line = usage_line("Current", 75.0, "");
        assert!(line.contains("\x1b[31m"));
    }

    #[test]
    fn usage_line_includes_suffix() {
        let line = usage_line("Current", 50.0, " mysuffix");
        assert!(line.ends_with(" mysuffix"));
    }

    #[test]
    fn usage_line_rounds_pct() {
        let line = usage_line("X", 49.6, "");
        assert!(line.contains("50%"));
    }

    #[test]
    fn reset_suffix_formats_correctly() {
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64 + 90 * 60;
        let s = reset_suffix(future);
        assert!(s.contains("↺"));
        assert!(s.contains("1h"));
        assert!(s.contains("30m"));
    }

    #[test]
    fn reset_suffix_zero_pads_minutes() {
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64 + 65 * 60;
        let s = reset_suffix(future);
        assert!(s.contains("05m"));
    }

    #[test]
    fn reset_suffix_past_returns_zero() {
        let s = reset_suffix(0i64);
        assert!(s.contains("0h00m"));
    }
}
