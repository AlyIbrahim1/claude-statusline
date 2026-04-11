mod history;
mod history_tui;
mod realtime;
mod realtime_paths;
mod status_model;

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

/// Returns terminal columns from COLUMNS env var.
fn terminal_columns() -> Option<usize> {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
}

/// Truncates a string by visible width while preserving SGR escape sequences.
fn truncate_visible(s: &str, max_visible: usize) -> String {
    if max_visible == 0 {
        return String::new();
    }
    if visible_len(s) <= max_visible {
        return s.to_string();
    }

    let mut out = String::new();
    let mut chars = s.chars().peekable();
    let mut visible = 0usize;

    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            out.push(ch);
            out.push(chars.next().unwrap_or('['));
            while chars.peek().map_or(false, |c| c.is_ascii_digit() || *c == ';') {
                out.push(chars.next().unwrap());
            }
            if let Some(term) = chars.peek().copied() {
                if "mGKHFABCDJ".contains(term) {
                    out.push(chars.next().unwrap());
                }
            }
            continue;
        }

        let w = if (ch as u32) > 0xFFFF { 2 } else { 1 };
        if visible + w > max_visible {
            break;
        }
        out.push(ch);
        visible += w;
    }

    out.push('…');
    out.push_str("\x1b[0m");
    out
}

/// Wraps ANSI strings by semantic chunks using a styled separator.
fn wrap_chunks(chunks: Vec<String>, width: Option<usize>, sep: &str) -> Vec<String> {
    let Some(max_width) = width else {
        return vec![chunks.join(sep)];
    };
    if max_width < 8 {
        return chunks
            .into_iter()
            .map(|c| truncate_visible(&c, max_width.saturating_sub(1)))
            .collect();
    }

    let sep_len = visible_len(sep);
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;

    for raw_chunk in chunks {
        let chunk = if visible_len(&raw_chunk) > max_width {
            truncate_visible(&raw_chunk, max_width.saturating_sub(1))
        } else {
            raw_chunk
        };
        let chunk_len = visible_len(&chunk);

        if cur.is_empty() {
            cur = chunk;
            cur_len = chunk_len;
            continue;
        }

        let needed = cur_len + sep_len + chunk_len;
        if needed <= max_width {
            cur.push_str(sep);
            cur.push_str(&chunk);
            cur_len = needed;
        } else {
            lines.push(cur);
            cur = chunk;
            cur_len = chunk_len;
        }
    }

    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
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

    let slug = abs_dir.replace(['/', '\\'], "-");
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
                            // Keep parity with JS: Math.round(cache_read_input_tokens * 0.1)
                            + (usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0).saturating_add(5) / 10)
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
            if args.len() >= 3 && args[2] == "--terminal" {
                history_tui::run();
            } else {
                history::handle_history();
            }
            return;
        } else if args[1] == "realtime" {
            if args.len() >= 3 && args[2] == "run" {
                let _ = realtime::run_renderer_loop();
                return;
            }
            if args.len() >= 3 && args[2] == "shutdown" {
                let _ = realtime::emit_lifecycle_event("shutdown");
                return;
            }
        } else if args[1] == "hook" && args.len() >= 3 {
            if args[2] == "start" {
                history::handle_hook_start();
                let _ = realtime::emit_lifecycle_event("session_start");
                return;
            } else if args[2] == "end" {
                history::handle_hook_end();
                let _ = realtime::emit_lifecycle_event("session_end");
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
    let _ = realtime::emit_state_update(&input);
    if let Some(out) = render(&input) {
        print!("{}", out);
    }
}

fn render(input: &str) -> Option<String> {
    use std::path::PathBuf;

    let data: serde_json::Value = serde_json::from_str(input).ok()?;
    let parsed = status_model::parse_status_input(&data);

    // Extract fields
    let model = parsed.model;
    let dir = parsed.dir;
    let session = parsed.session;

    // Context bar
    let ctx = parsed.remaining_pct
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
        format!("\x1b[97m{}↓ {}↑\x1b[0m", format_tokens(t_in), format_tokens(t_out))
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

    let mut line2_chunks = vec!["\x1b[0m\x1b[32mUsage\x1b[0m".to_string()];
    if !usage_content.is_empty() {
        line2_chunks.push(usage_content);
    }
    if !cost_display.is_empty() {
        line2_chunks.push(cost_display.trim_start().to_string());
    }
    if !token_display.is_empty() {
        line2_chunks.push(token_display);
    }

    // Agent display
    let agent_display = if active_agents > 0 {
        format!(" \x1b[0m\x1b[36m↪ {}\x1b[0m", active_agents)
    } else {
        String::new()
    };

    let model_display = format!("\x1b[0m\x1b[94m{}\x1b[0m{}{}", model, effort_sfx, agent_display);

    let mut line1_chunks = vec![model_display];
    if !task.is_empty() {
        line1_chunks.push(format!("\x1b[1m{}\x1b[0m", task));
    }
    line1_chunks.push(format!("{}{}", dir_display, ctx));

    let columns = terminal_columns();
    let sep_token = " \x1b[2m│\x1b[0m ";
    let wrapped_line1 = wrap_chunks(line1_chunks, columns, sep_token);
    let sep_len = wrapped_line1.iter().map(|l| visible_len(l)).max().unwrap_or(0);
    let sep = format!("\x1b[2m{}\x1b[0m", "─".repeat(sep_len));

    let line2 = if line2_chunks.len() > 1 {
        wrap_chunks(line2_chunks, columns, sep_token)
    } else {
        Vec::new()
    };

    let output = if !line2.is_empty() {
        format!("{}\n{}\n{}", wrapped_line1.join("\n"), sep, line2.join("\n"))
    } else {
        wrapped_line1.join("\n")
    };

    Some(output)
}

#[cfg(test)]
#[path = "../tests/rust_unit/main_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/rust_unit/realtime_tests.rs"]
mod realtime_tests;
