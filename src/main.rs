mod history;
mod history_tui;
mod session;
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

/// `12.3k↓ + 1.2M cache 8.1k↑`; the cache part is dimmed and omitted when zero.
fn token_display(tin: u64, tcache: u64, tout: u64) -> String {
    let cache = if tcache > 0 {
        format!(" \x1b[2m+ {} cache\x1b[0m\x1b[97m", format_tokens(tcache))
    } else {
        String::new()
    };
    format!("\x1b[97m{}↓{} {}↑\x1b[0m", format_tokens(tin), cache, format_tokens(tout))
}

/// Maps stdin `effort.level` to the ANSI effort suffix.
fn effort_suffix_from_level(level: &str) -> String {
    match level {
        "low"    => format!(" \x1b[0m\x1b[32m[L]\x1b[0m"),
        "medium" => format!(" \x1b[0m\x1b[33m[M]\x1b[0m"),
        "high"   => format!(" \x1b[0m\x1b[38;5;208m[H]\x1b[0m"),
        "xhigh"  => format!(" \x1b[0m\x1b[38;5;202m[XH]\x1b[0m"),
        "max"    => format!(" \x1b[0m\x1b[31m[MAXX]\x1b[0m"),
        _        => String::new(),
    }
}

/// Returns the user's home directory. Checks $HOME then $USERPROFILE (Windows).
fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Directory label: `~`, `~/base`, `~/parent/base` under home; `parent/base` elsewhere.
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
        let prefix = if abs_dir.starts_with(home_dir) { "~/" } else { "" };
        format!("{}{}/{}", prefix, parent_name, base_name)
    }
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
        } else if args[1] == "hook" && args.len() >= 3 {
            if args[2] == "start" {
                // No-op: kept so SessionStart hooks written by older versions still exit 0.
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
    let parsed = status_model::parse_status_input(&data);

    // Extract fields
    let model = parsed.model;
    let dir = parsed.dir;
    let session = parsed.session;

    // Context bar
    let ctx = parsed.remaining_pct
        .map(context_bar)
        .unwrap_or_default();

    let home_dir = dirs_home();
    let abs_dir = std::fs::canonicalize(&dir).unwrap_or_else(|_| PathBuf::from(&dir));

    // Per-session state: transcript cursors, token totals, git baselines
    let state_file = session::state_path(&session::claude_dir(), &session);
    let loaded = state_file.as_deref().map(session::load).unwrap_or_default();
    let mut state = loaded.clone();
    if let Some(path) = &state_file {
        if loaded.start == 0 {
            // First render of this session.
            if let Some(dir) = path.parent() {
                session::prune_abandoned(dir);
            }
        }
        state.note_input(&data, &model, &dir);
    }

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
    let (branch, commit_count) = session::git_info(&abs_dir, &mut state);
    let branch = sanitize(&branch);

    // Session tokens from the transcript (and subagent transcripts), deduplicated
    let transcript = data["transcript_path"].as_str().unwrap_or("");
    if !transcript.is_empty() {
        session::update_tokens(&mut state, std::path::Path::new(transcript));
    }
    let token_display = if state.files.is_empty() {
        String::new()
    } else {
        token_display(state.tin, state.tcache, state.tout)
    };

    if let Some(path) = &state_file {
        if state != loaded {
            session::save(path, &state);
        }
    }

    let effort_sfx = effort_suffix_from_level(data["effort"]["level"].as_str().unwrap_or(""));

    // Dir display: ~/parent/base format with (branch) +N style
    let dirname = sanitize(&dir_label(&abs_dir, &home_dir));
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

    let model_display = format!("\x1b[0m\x1b[94m{}\x1b[0m{}", model, effort_sfx);

    let mut line1_chunks = vec![model_display];
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
