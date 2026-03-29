mod history;

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

/// Formats a token count: >= 1_000_000 → "1M"/"1.1M", >= 1000 → "5.3k", else plain number.
fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if n % 1_000_000 == 0 {
            format!("{}M", n / 1_000_000)
        } else {
            format!("{:.1}M", m)
        }
    } else if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
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

/// Builds the directory label with tilde abbreviation: `~`, `~/base`, or `~/parent/base`.
/// Matches JS: absDir === homeDir → "~", parent === homeDir → "~/base", else "~/parent/base".
fn dir_label(abs_dir: &std::path::Path, home_dir: &std::path::Path) -> String {
    if abs_dir == home_dir {
        "~".to_string()
    } else if abs_dir.parent() == Some(home_dir) {
        format!(
            "~/{}",
            abs_dir.file_name().unwrap_or_default().to_string_lossy()
        )
    } else {
        let parent_name = abs_dir
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let base_name = abs_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| abs_dir.to_string_lossy().to_string());
        format!("~/{}/{}", parent_name, base_name)
    }
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

/// Returns the current HEAD SHA, or "" on any failure.
fn git_head_sha(dir: &str) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
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

/// Returns the number of commits made since the session baseline SHA.
/// Stores the baseline SHA in a per-session JSON file on first call.
/// All errors silently return 0.
fn session_commit_count(
    dir: &str,
    session: &str,
    claude_dir: &std::path::Path,
    abs_dir: &str,
) -> usize {
    use std::fs;

    if session.is_empty() {
        return 0;
    }

    let head_sha = git_head_sha(dir);
    if head_sha.is_empty() {
        return 0;
    }

    let session_file = claude_dir.join(format!("statusline-session-{}.json", session));
    let mut session_data: serde_json::Value = fs::read_to_string(&session_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::json!({}));

    if session_data[abs_dir].is_null() {
        session_data[abs_dir] = serde_json::Value::String(head_sha.clone());
        let _ = fs::write(
            &session_file,
            serde_json::to_string(&session_data).unwrap_or_default(),
        );
        return 0;
    }

    let baseline = session_data[abs_dir].as_str().unwrap_or("").to_string();
    if baseline == head_sha {
        return 0;
    }

    std::process::Command::new("git")
        .args(["rev-list", "--count", &format!("{}..HEAD", baseline)])
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|o| if o.status.success() { Some(o.stdout) } else { None })
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

/// Cumulative token totals read from the session JSONL file.
struct TokenTotals {
    total_in: u64,
    total_out: u64,
}

/// Reads cumulative token totals from the session JSONL file using a byte-offset cache
/// so only new bytes are parsed on each invocation (O(new bytes) not O(file)).
/// Returns None on any error (missing file, bad JSON, etc.).
fn read_session_tokens(
    claude_dir: &std::path::Path,
    session: &str,
    abs_dir: &str,
) -> Option<TokenTotals> {
    use std::io::{Seek, SeekFrom};

    if session.is_empty() {
        return None;
    }

    let slug = abs_dir.replace('/', "-");
    let jsonl_path = claude_dir
        .join("projects")
        .join(&slug)
        .join(format!("{}.jsonl", session));
    let cache_path = claude_dir.join(format!("statusline-tokcache-{}.json", session));

    let file_size = std::fs::metadata(&jsonl_path).ok()?.len();

    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut cached_offset: u64 = 0;

    if let Ok(cache_text) = std::fs::read_to_string(&cache_path) {
        if let Ok(cached) = serde_json::from_str::<serde_json::Value>(&cache_text) {
            total_in = cached["totalIn"].as_u64().unwrap_or(0);
            total_out = cached["totalOut"].as_u64().unwrap_or(0);
            cached_offset = cached["offset"].as_u64().unwrap_or(0).min(file_size);
        }
    }

    if file_size > cached_offset {
        let mut file = std::fs::File::open(&jsonl_path).ok()?;
        file.seek(SeekFrom::Start(cached_offset)).ok()?;
        let mut content = String::new();
        file.read_to_string(&mut content).ok()?;

        let lines: Vec<&str> = content.split('\n').collect();
        // Skip the last element: either empty string (file ends with \n)
        // or a potentially incomplete line (file was mid-write).
        let safe_lines = &lines[..lines.len().saturating_sub(1)];

        for line in safe_lines {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                if entry["type"] == "assistant" {
                    if let Some(usage) = entry["message"]["usage"].as_object() {
                        total_in += usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0)
                            + (usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) / 10)
                            + usage
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                        total_out += usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                    }
                }
            }
        }

        // Advance offset by bytes of all complete lines (each terminated by \n)
        let processed_bytes: u64 = safe_lines.iter().map(|l| l.len() as u64 + 1).sum();
        let cache_content = serde_json::json!({
            "totalIn": total_in,
            "totalOut": total_out,
            "offset": cached_offset + processed_bytes,
        });
        let _ = std::fs::write(
            &cache_path,
            serde_json::to_string(&cache_content).unwrap_or_default(),
        );
    }

    Some(TokenTotals { total_in, total_out })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 {
        if args[1] == "history" {
            history::handle_history();
            return;
        } else if args[1] == "hook" && args.len() >= 3 {
            if args[2] == "start" {
                history::handle_hook_start();
                return;
            } else if args[2] == "end" {
                history::handle_hook_end();
                return;
            }
        }
    }

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

fn render(input: &str) -> Option<String> {
    use std::path::PathBuf;

    let data: serde_json::Value = serde_json::from_str(input).ok()?;

    // Extract fields
    let model = {
        let m = sanitize(data["model"]["display_name"].as_str().unwrap_or(""));
        if m.is_empty() { "Claude".to_string() } else { m }
    };
    let dir = {
        let d = data["workspace"]["current_dir"].as_str().unwrap_or("").to_string();
        if d.is_empty() {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else { d }
    };
    let session = data["session_id"].as_str().unwrap_or("").to_string();

    // Context bar
    let ctx = data["context_window"]["remaining_percentage"]
        .as_f64()
        .map(context_bar)
        .unwrap_or_default();

    // Claude dir and home dir
    let home_dir = dirs_home();
    let claude_dir: PathBuf = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".claude"));

    // Absolute path for slug/session keys — use as-is if canonicalize fails
    let abs_dir = std::fs::canonicalize(&dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| dir.clone());

    // Todos
    let (task, active_agents) = scan_todos(&claude_dir, &session);

    // Cost / rate limits
    // is_subscription = rate_limits key exists (even if null/empty object)
    let is_subscription = data.get("rate_limits").is_some();
    let session_cost: Option<f64> = if !is_subscription {
        data["cost"]["total_cost_usd"].as_f64()
    } else {
        None
    };

    let pct_5h = data["rate_limits"]["five_hour"]["used_percentage"].as_f64();
    let pct_week = data["rate_limits"]["seven_day"]["used_percentage"].as_f64();
    let resets_at_5h = data["rate_limits"]["five_hour"]["resets_at"].as_i64();

    let reset_sfx = resets_at_5h.map(reset_suffix).unwrap_or_default();
    let u5h = pct_5h.map(|p| usage_line("Current", p, &reset_sfx)).unwrap_or_default();
    let u7d = pct_week.map(|p| usage_line("Weekly", p, "")).unwrap_or_default();

    // Git branch + session commit counter
    let branch = sanitize(&git_branch(&dir));
    let commit_count = if !branch.is_empty() && !session.is_empty() {
        session_commit_count(&dir, &session, &claude_dir, &abs_dir)
    } else {
        0
    };

    // JSONL token totals — prefer over stdin snapshot when larger
    let stdin_in = data["context_window"]["total_input_tokens"].as_u64();
    let stdin_out = data["context_window"]["total_output_tokens"].as_u64();
    let jsonl_tok = read_session_tokens(&claude_dir, &session, &abs_dir);
    let total_in = match &jsonl_tok {
        Some(t) if t.total_in > stdin_in.unwrap_or(0) => Some(t.total_in),
        _ => stdin_in,
    };
    let total_out = match &jsonl_tok {
        Some(t) if t.total_out > stdin_out.unwrap_or(0) => Some(t.total_out),
        _ => stdin_out,
    };
    let token_display = if total_in.is_some() || total_out.is_some() || jsonl_tok.is_some() {
        let t_in = total_in.unwrap_or(0);
        let t_out = total_out.unwrap_or(0);
        format!("\x1b[2m│\x1b[0m \x1b[97m{}↓ {}↑\x1b[0m", format_tokens(t_in), format_tokens(t_out))
    } else {
        String::new()
    };

    // Effort
    let effort_sfx = effort_suffix(&model, &claude_dir);

    // Dir display: ~/parent/base format with (branch) +N style
    let abs_dir_path = std::path::Path::new(&abs_dir);
    let dirname = sanitize(&dir_label(abs_dir_path, &home_dir));
    let dir_display = if !branch.is_empty() {
        let commit_suffix = if commit_count > 0 {
            format!(" \x1b[32m+{}", commit_count)
        } else {
            String::new()
        };
        let branch_str = format!("({}){}\x1b[0m \x1b[2m│\x1b[0m", branch, commit_suffix);
        format!("\x1b[1m\x1b[97m{}\x1b[0m\x1b[2m \x1b[36m{}\x1b[0m", dirname, branch_str)
    } else {
        format!("\x1b[1m\x1b[97m{}\x1b[0m", dirname)
    };

    // Cost display — note: two leading spaces is intentional, matches JS source
    let cost_display = session_cost
        .map(|c| format!("  \x1b[33m{}\x1b[0m", format_cost(c)))
        .unwrap_or_default();

    // Usage content: weekly first, then current (matches JS [u7d, u5h] order)
    let usage_parts: Vec<&str> = [u7d.as_str(), u5h.as_str()]
        .iter().copied().filter(|s| !s.is_empty()).collect();
    let usage_content = usage_parts.join("  ");

    // line2: usage, cost, token display
    let line2_parts: Vec<&str> = [usage_content.as_str(), cost_display.as_str(), token_display.as_str()]
        .iter().copied().filter(|s| !s.is_empty()).collect();
    let line2 = if !line2_parts.is_empty() {
        format!("\x1b[0m\x1b[32mUsage\x1b[0m \x1b[2m│\x1b[0m {}", line2_parts.join("  "))
    } else {
        String::new()
    };

    // Agent display
    let agent_display = if active_agents > 0 {
        format!(" \x1b[0m\x1b[36m↪ {}\x1b[0m", active_agents)
    } else {
        String::new()
    };

    let model_display = format!("\x1b[0m\x1b[94m{}\x1b[0m{}{}", model, effort_sfx, agent_display);

    let line1 = if !task.is_empty() {
        format!("{} \x1b[2m│\x1b[0m \x1b[1m{}\x1b[0m \x1b[2m│\x1b[0m {}{}", model_display, task, dir_display, ctx)
    } else {
        format!("{} \x1b[2m│\x1b[0m {}{}", model_display, dir_display, ctx)
    };

    let sep_len = visible_len(&line1);
    let sep = format!("\x1b[2m{}\x1b[0m", "─".repeat(sep_len));

    let output = if !line2.is_empty() {
        format!("{}\n{}\n{}", line1, sep, line2)
    } else {
        line1
    };

    Some(output)
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
    fn format_tokens_small() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(0), "0");
    }

    #[test]
    fn format_tokens_thousands() {
        assert_eq!(format_tokens(1000), "1.0k");
        assert_eq!(format_tokens(5300), "5.3k");
        assert_eq!(format_tokens(12500), "12.5k");
    }

    #[test]
    fn format_tokens_millions() {
        assert_eq!(format_tokens(1_000_000), "1M");
        assert_eq!(format_tokens(1_100_000), "1.1M");
        assert_eq!(format_tokens(10_500_000), "10.5M");
        assert_eq!(format_tokens(2_000_000), "2M");
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

    #[test]
    fn dir_label_is_home() {
        let home = std::path::Path::new("/home/user");
        assert_eq!(dir_label(home, home), "~");
    }

    #[test]
    fn dir_label_direct_child_of_home() {
        let abs = std::path::Path::new("/home/user/myproject");
        let home = std::path::Path::new("/home/user");
        assert_eq!(dir_label(abs, home), "~/myproject");
    }

    #[test]
    fn dir_label_nested_path() {
        let abs = std::path::Path::new("/home/user/projects/myapp");
        let home = std::path::Path::new("/home/user");
        assert_eq!(dir_label(abs, home), "~/projects/myapp");
    }

    #[test]
    fn dir_label_unrelated_path() {
        let abs = std::path::Path::new("/tmp/foo/bar");
        let home = std::path::Path::new("/home/user");
        assert_eq!(dir_label(abs, home), "~/foo/bar");
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

    #[test]
    fn read_session_tokens_missing_file_returns_none() {
        let tmp = std::env::temp_dir().join(format!("sl_tok_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let result = read_session_tokens(&tmp, "nosuchsession", "/no/such/dir");
        assert!(result.is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_session_tokens_parses_jsonl() {
        let tmp = std::env::temp_dir().join(format!("sl_tok_test2_{}", std::process::id()));
        let slug = "-tmp-myproject";
        let projects_dir = tmp.join("projects").join(slug);
        std::fs::create_dir_all(&projects_dir).unwrap();
        let session = "testsession";
        let jsonl = concat!(
            "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"cache_read_input_tokens\":200,\"cache_creation_input_tokens\":0}}}\n",
            "{\"type\":\"user\",\"message\":{}}\n",
            "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n",
        );
        std::fs::write(projects_dir.join(format!("{}.jsonl", session)), jsonl).unwrap();
        let result = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
        // total_in = (100 + 200/10 + 0) + (10 + 0 + 0) = 130
        // total_out = 50 + 5 = 55
        assert_eq!(result.total_in, 130);
        assert_eq!(result.total_out, 55);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_session_tokens_uses_offset_cache() {
        let tmp = std::env::temp_dir().join(format!("sl_tok_test3_{}", std::process::id()));
        let slug = "-tmp-myproject";
        let projects_dir = tmp.join("projects").join(slug);
        std::fs::create_dir_all(&projects_dir).unwrap();
        let session = "testsession2";
        let line1 = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
        std::fs::write(projects_dir.join(format!("{}.jsonl", session)), line1).unwrap();
        // First read
        let r1 = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
        assert_eq!(r1.total_in, 100);
        // Append a second line
        let line2 = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":20,\"output_tokens\":10,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(projects_dir.join(format!("{}.jsonl", session)))
            .unwrap();
        f.write_all(line2.as_bytes()).unwrap();
        // Second read — should pick up only the new line via offset cache
        let r2 = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
        assert_eq!(r2.total_in, 120);
        assert_eq!(r2.total_out, 60);
        std::fs::remove_dir_all(&tmp).ok();
    }

    fn make_basic_input(model: &str) -> String {
        serde_json::json!({
            "model": {"display_name": model},
            "workspace": {"current_dir": "/tmp/myproject"},
            "session_id": "",
            "context_window": {"remaining_percentage": 90.0}
        }).to_string()
    }

    #[test]
    fn render_returns_some_for_valid_input() {
        assert!(render(&make_basic_input("claude-sonnet-4-6")).is_some());
    }

    #[test]
    fn render_contains_model_name() {
        let out = render(&make_basic_input("claude-sonnet-4-6")).unwrap();
        assert!(out.contains("claude-sonnet-4-6"));
    }

    #[test]
    fn render_contains_dirname() {
        let out = render(&make_basic_input("M")).unwrap();
        assert!(out.contains("myproject"));
    }

    #[test]
    fn render_dirname_uses_parent_slash_base_format() {
        let out = render(&make_basic_input("M")).unwrap();
        // /tmp/myproject → ~/tmp/myproject (when HOME is not /tmp)
        // At minimum the path separator format should be present
        assert!(out.contains("myproject"));
        // Should not show bare basename without path context (old [branch] style)
        assert!(!out.contains("[main]") && !out.contains("[master]"),
            "branch should use () not [] format");
    }

    #[test]
    fn render_branch_uses_parens_format() {
        // Verify branch is shown with () not [] when present
        // (branch detection depends on git being available in the test env)
        let out = render(&make_basic_input("M")).unwrap();
        // If a branch is shown, it must not use square brackets
        if out.contains('(') {
            assert!(!out.contains('['), "branch format should use () not []");
        }
    }

    #[test]
    fn render_returns_none_for_invalid_json() {
        assert!(render("not json").is_none());
    }

    #[test]
    fn render_defaults_model_to_claude() {
        let input = serde_json::json!({"session_id": ""}).to_string();
        let out = render(&input).unwrap();
        assert!(out.contains("Claude"));
    }

    #[test]
    fn render_shows_usage_line_for_subscription() {
        let input = serde_json::json!({
            "model": {"display_name": "M"},
            "session_id": "",
            "rate_limits": {
                "five_hour": {"used_percentage": 30.0, "resets_at": 9999999999i64},
                "seven_day": {"used_percentage": 20.0}
            }
        }).to_string();
        let out = render(&input).unwrap();
        assert!(out.contains("Usage"));
        assert!(out.contains("30%"));
    }

    #[test]
    fn render_shows_cost_for_api_key_users() {
        let input = serde_json::json!({
            "model": {"display_name": "M"},
            "session_id": "",
            "cost": {"total_cost_usd": 0.0042}
        }).to_string();
        let out = render(&input).unwrap();
        assert!(out.contains("$0.0042"));
    }

    #[test]
    fn render_shows_token_display_from_stdin() {
        let input = serde_json::json!({
            "model": {"display_name": "M"},
            "session_id": "",
            "context_window": {
                "remaining_percentage": 80.0,
                "total_input_tokens": 3000,
                "total_output_tokens": 500
            }
        }).to_string();
        let out = render(&input).unwrap();
        assert!(out.contains("↓"), "expected input token display down arrow");
        assert!(out.contains("↑"), "expected output token display up arrow");
        assert!(out.contains("3.0k↓ 500↑"), "expected separated tokens");
    }

    #[test]
    fn render_no_trailing_newline() {
        let out = render(&make_basic_input("M")).unwrap();
        assert!(!out.ends_with('\n'));
    }

    #[test]
    fn render_sep_length_matches_line1_visible_length() {
        let input = serde_json::json!({
            "model": {"display_name": "M"},
            "session_id": "",
            "rate_limits": {
                "five_hour": {"used_percentage": 30.0, "resets_at": 9999999999i64},
                "seven_day": {"used_percentage": 20.0}
            }
        }).to_string();
        let out = render(&input).unwrap();
        if out.contains('\n') {
            let lines: Vec<&str> = out.splitn(3, '\n').collect();
            let line1_len = visible_len(lines[0]);
            let sep_visible = visible_len(lines[1]);
            assert_eq!(line1_len, sep_visible);
        }
    }
}
