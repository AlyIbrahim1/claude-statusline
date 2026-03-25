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

fn format_cost(cost: f64) -> String {
    if cost < 0.01 {
        format!("${:.4}", cost)
    } else {
        format!("${:.2}", cost)
    }
}

/// Pure function for testing: maps a level string to the ANSI effort suffix.
fn effort_suffix_from_level(level: &str) -> String {
    match level {
        "low"    => format!(" \x1b[0m\x1b[32m[L]\x1b[0m"),
        "medium" => format!(" \x1b[0m\x1b[33m[M]\x1b[0m"),
        "high"   => format!(" \x1b[0m\x1b[38;5;208m[H]\x1b[0m"),
        "max"    => format!(" \x1b[0m\x1b[31m[MAXX]\x1b[0m"),
        _        => String::new(),
    }
}

/// Resolves effort level from env → settings.json → model default, then formats.
fn effort_suffix(model: &str, claude_dir: &std::path::Path) -> String {
    use std::fs;

    let raw = std::env::var("CLAUDE_CODE_EFFORT_LEVEL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let text = fs::read_to_string(claude_dir.join("settings.json")).ok()?;
            let v: serde_json::Value = serde_json::from_str(&text).ok()?;
            let s = v["effortLevel"].as_str()?.to_string();
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| {
            let m = model.to_lowercase();
            if m.contains("sonnet-4") || m.contains("opus-4") {
                "medium".to_string()
            } else {
                String::new()
            }
        });

    effort_suffix_from_level(&raw.to_lowercase())
}

/// Scans `claude_dir/todos/` for agent todo files matching the session.
/// Returns (task_display_string, active_agent_count). All errors silently ignored.
fn scan_todos(claude_dir: &std::path::Path, session: &str) -> (String, usize) {
    use std::fs;

    if session.is_empty() {
        return (String::new(), 0);
    }
    let todos_dir = claude_dir.join("todos");
    if !todos_dir.exists() {
        return (String::new(), 0);
    }

    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> = fs::read_dir(&todos_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            n.starts_with(session) && n.contains("-agent-") && n.ends_with(".json")
        })
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((e.path(), mtime))
        })
        .collect();

    // Sort newest first (mtime descending)
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let mut task = String::new();
    let mut active_agents = 0usize;

    for (path, _) in &entries {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(serde_json::Value::Array(todos)) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(in_progress) = todos.iter().find(|t| t["status"] == "in_progress") {
                    active_agents += 1;
                    if task.is_empty() {
                        task = sanitize(in_progress["activeForm"].as_str().unwrap_or(""));
                    }
                }
            }
        }
    }

    (task, active_agents)
}

/// Returns the user's home directory. Checks $HOME then $USERPROFILE (Windows).
fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Returns the current git branch name, or "" on any failure.
fn git_branch(dir: &str) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|o| if o.status.success() { Some(o.stdout) } else { None })
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
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

    #[test]
    fn format_cost_small_uses_4_decimals() {
        assert_eq!(format_cost(0.0099), "$0.0099");
    }

    #[test]
    fn format_cost_large_uses_2_decimals() {
        assert_eq!(format_cost(0.01), "$0.01");
        assert_eq!(format_cost(1.5), "$1.50");
    }

    #[test]
    fn effort_suffix_low() {
        let s = effort_suffix_from_level("low");
        assert!(s.contains("[L]"));
        assert!(s.contains("\x1b[32m"));
    }

    #[test]
    fn effort_suffix_medium() {
        let s = effort_suffix_from_level("medium");
        assert!(s.contains("[M]"));
        assert!(s.contains("\x1b[33m"));
    }

    #[test]
    fn effort_suffix_high() {
        let s = effort_suffix_from_level("high");
        assert!(s.contains("[H]"));
        assert!(s.contains("\x1b[38;5;208m"));
    }

    #[test]
    fn effort_suffix_max() {
        let s = effort_suffix_from_level("max");
        assert!(s.contains("[MAXX]"));
        assert!(s.contains("\x1b[31m"));
    }

    #[test]
    fn effort_suffix_unknown_is_empty() {
        assert_eq!(effort_suffix_from_level(""), "");
        assert_eq!(effort_suffix_from_level("unknown"), "");
    }

    fn write_todo_file(dir: &std::path::Path, name: &str, todos: &serde_json::Value) {
        std::fs::write(dir.join(name), serde_json::to_string(todos).unwrap()).unwrap();
    }

    #[test]
    fn scan_todos_finds_active_task() {
        let tmp = std::env::temp_dir().join(format!("sl_test_{}", std::process::id()));
        let todos_dir = tmp.join("todos");
        std::fs::create_dir_all(&todos_dir).unwrap();
        let session = "sess123";
        write_todo_file(&todos_dir, "sess123-agent-1.json", &serde_json::json!([
            {"status": "in_progress", "activeForm": "Writing tests"}
        ]));
        let (task, agents) = scan_todos(&tmp, session);
        assert_eq!(task, "Writing tests");
        assert_eq!(agents, 1);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_todos_ignores_non_agent_files() {
        let tmp = std::env::temp_dir().join(format!("sl_test2_{}", std::process::id()));
        let todos_dir = tmp.join("todos");
        std::fs::create_dir_all(&todos_dir).unwrap();
        write_todo_file(&todos_dir, "sess123-other.json", &serde_json::json!([
            {"status": "in_progress", "activeForm": "Should not appear"}
        ]));
        let (task, agents) = scan_todos(&tmp, "sess123");
        assert_eq!(task, "");
        assert_eq!(agents, 0);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_todos_counts_multiple_agents() {
        let tmp = std::env::temp_dir().join(format!("sl_test3_{}", std::process::id()));
        let todos_dir = tmp.join("todos");
        std::fs::create_dir_all(&todos_dir).unwrap();
        let session = "abc";
        write_todo_file(&todos_dir, "abc-agent-1.json", &serde_json::json!([
            {"status": "in_progress", "activeForm": "First task"}
        ]));
        // Sleep to ensure distinct mtime so sort order is deterministic (newest = agent-2)
        std::thread::sleep(std::time::Duration::from_millis(15));
        write_todo_file(&todos_dir, "abc-agent-2.json", &serde_json::json!([
            {"status": "in_progress", "activeForm": "Second task"}
        ]));
        let (task, agents) = scan_todos(&tmp, session);
        assert_eq!(agents, 2);
        assert_eq!(task, "Second task");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_todos_returns_empty_when_no_in_progress() {
        let tmp = std::env::temp_dir().join(format!("sl_test4_{}", std::process::id()));
        let todos_dir = tmp.join("todos");
        std::fs::create_dir_all(&todos_dir).unwrap();
        write_todo_file(&todos_dir, "sess-agent-1.json", &serde_json::json!([
            {"status": "completed", "activeForm": "Done"}
        ]));
        let (task, agents) = scan_todos(&tmp, "sess");
        assert_eq!(task, "");
        assert_eq!(agents, 0);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_todos_empty_session_returns_empty() {
        let tmp = std::env::temp_dir().join(format!("sl_test5_{}", std::process::id()));
        let (task, agents) = scan_todos(&tmp, "");
        assert_eq!(task, "");
        assert_eq!(agents, 0);
    }
}
