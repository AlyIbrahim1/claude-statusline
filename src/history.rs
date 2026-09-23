//! Session history: one line per finished session in `<claude_dir>/statusline/history.js`.
//!
//! Each line is `h([id,project,model,start,dur,in,cache,out,cost,reason]);` — valid JSON inside
//! a JS call, so the dashboard page can load the file directly with `<script src>`.
//! The file is only ever appended to. Readers keep the last line per id, so a resumed
//! session (or one finalized early by the stale sweep) is never counted twice.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::session::{self, State};

/// Session state files untouched this long belong to sessions that ended without SessionEnd.
const STALE_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Record {
    pub id: String,
    pub project_name: String,
    pub model: String,
    /// Unix seconds
    pub start: u64,
    /// UTC "YYYY-MM-DD HH:MM:SS"
    pub start_time: String,
    pub duration_seconds: i64,
    pub tokens_in: u64,
    pub tokens_cache: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
    pub exit_reason: String,
}

pub fn history_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("statusline").join("history.js")
}

/// Converts Unix seconds to "YYYY-MM-DD HH:MM:SS" using the Howard Hinnant algorithm.
fn unix_secs_to_str(secs: u64) -> String {
    let sec  = (secs % 60) as u32;
    let min  = ((secs / 60) % 60) as u32;
    let hour = ((secs / 3600) % 24) as u32;
    let mut days = (secs / 86400) as u32;

    days += 719468;
    let era  = days / 146097;
    let doe  = days - era * 146097;
    let yoe  = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y    = yoe + era * 400;
    let doy  = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp   = (5 * doy + 2) / 153;
    let d    = doy - (153 * mp + 2) / 5 + 1;
    let m    = if mp < 10 { mp + 3 } else { mp - 9 };
    let y    = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, hour, min, sec)
}

/// Parses "YYYY-MM-DD HH:MM:SS" back to Unix seconds (inverse of unix_secs_to_str).
fn parse_datetime_to_unix_secs(s: &str) -> Option<u64> {
    let p: Vec<u64> = s.split(|c| c == '-' || c == ' ' || c == ':')
        .filter_map(|x| x.parse().ok())
        .collect();
    if p.len() < 6 { return None; }
    let (y, m, d, h, mi, sec) = (p[0], p[1], p[2], p[3], p[4], p[5]);

    let (m2, y2) = if m <= 2 { (m + 9, y - 1) } else { (m - 3, y) };
    let era  = y2 / 400;
    let yoe  = y2 - era * 400;
    let doy  = (153 * m2 + 2) / 5 + d - 1;
    let doe  = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe;
    let days = days.checked_sub(719468)?;

    Some(days * 86400 + h * 3600 + mi * 60 + sec)
}

fn format_line(id: &str, project: &str, model: &str, start: u64, dur: u64,
               tin: u64, tcache: u64, tout: u64, cost: f64, reason: &str) -> String {
    let id: String = id.chars().take(8).collect();
    let cost = (cost * 10_000.0).round() / 10_000.0;
    let row = json!([id, project, model, start, dur, tin, tcache, tout, cost, reason]);
    format!("h({row});\n")
}

fn parse_line(line: &str) -> Option<Record> {
    let inner = line.trim().strip_prefix("h(")?.strip_suffix(");")?;
    let Value::Array(v) = serde_json::from_str::<Value>(inner).ok()? else { return None };
    let s = |i: usize| v.get(i).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let n = |i: usize| v.get(i).and_then(|x| x.as_u64()).unwrap_or(0);
    let start = n(3);
    Some(Record {
        id: s(0),
        project_name: s(1),
        model: s(2),
        start,
        start_time: unix_secs_to_str(start),
        duration_seconds: n(4) as i64,
        tokens_in: n(5),
        tokens_cache: n(6),
        tokens_out: n(7),
        cost_usd: v.get(8).and_then(|x| x.as_f64()).unwrap_or(0.0),
        exit_reason: s(9),
    })
}

/// All sessions, newest first, keeping only the last line per id.
pub fn read_history(path: &Path) -> Vec<Record> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut latest: HashMap<String, Record> = HashMap::new();
    let mut anonymous = Vec::new();
    for rec in text.lines().filter_map(parse_line) {
        if rec.id.is_empty() {
            anonymous.push(rec);
        } else {
            latest.insert(rec.id.clone(), rec);
        }
    }
    let mut all: Vec<Record> = latest.into_values().chain(anonymous).collect();
    all.sort_by(|a, b| b.start.cmp(&a.start));
    all
}

fn append(path: &Path, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // ponytail: one small O_APPEND write per call is atomic on local filesystems, so no lock.
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(text.as_bytes());
    }
}

/// History line for a session state, or "" when the session used no tokens.
fn record_line(id: &str, state: &State, reason: &str, now: u64) -> String {
    if state.tin + state.tcache + state.tout == 0 {
        return String::new();
    }
    let start = if state.start == 0 { now } else { state.start };
    let dur = if state.dur > 0 { state.dur } else { now.saturating_sub(start) };
    let model = if state.model.is_empty() { "Claude" } else { &state.model };
    format_line(id, &state.project, model, start, dur, state.tin, state.tcache, state.tout, state.cost, reason)
}

fn remove_state(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("tmp"));
}

/// Writes the history line for a finished session and deletes its state file.
pub fn finalize(claude_dir: &Path, session_id: &str, transcript: &str, reason: &str, now: u64) {
    let Some(state_file) = session::state_path(claude_dir, session_id) else { return };
    let mut state = session::load(&state_file);
    if !transcript.is_empty() {
        // Catch up on the last turn, which may not have been rendered.
        session::update_tokens(&mut state, Path::new(transcript));
    }
    append(&history_path(claude_dir), &record_line(session_id, &state, reason, now));
    remove_state(&state_file);
}

/// Finalizes state files of sessions that ended without a SessionEnd hook (crash, kill).
pub fn sweep_stale(claude_dir: &Path, now: u64) {
    let dir = claude_dir.join("statusline").join("sessions");
    let Ok(entries) = fs::read_dir(&dir) else { return };
    let mut lines = String::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
            .map_or(0, |d| d.as_secs());
        if age < STALE_SECS {
            continue;
        }
        if path.extension().map_or(false, |e| e == "json") {
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            lines.push_str(&record_line(&id, &session::load(&path), "other", now));
        }
        remove_state(&path);
    }
    append(&history_path(claude_dir), &lines);
}

/// One-time move from the pre-1.7 layout: converts `statusline-history.jsonl` (always under
/// `~/.claude`) and deletes the loose per-session and realtime files.
pub fn migrate_legacy(claude_dir: &Path, home_claude_dir: &Path) {
    let legacy = home_claude_dir.join("statusline-history.jsonl");
    if let Ok(text) = fs::read_to_string(&legacy) {
        let mut lines = String::new();
        for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
            let reason = v["exit_reason"].as_str().unwrap_or("");
            if reason.is_empty() || reason == "pending" {
                continue;
            }
            let start = parse_datetime_to_unix_secs(v["start_time"].as_str().unwrap_or("")).unwrap_or(0);
            // No id: the old hook guessed session ids and often gave several sessions the same
            // one, so deduplicating would merge distinct rows.
            lines.push_str(&format_line(
                "",
                v["project_name"].as_str().unwrap_or(""),
                v["model"].as_str().unwrap_or("Claude"),
                start,
                v["duration_seconds"].as_u64().unwrap_or(0),
                v["tokens_in"].as_u64().unwrap_or(0),
                0,
                v["tokens_out"].as_u64().unwrap_or(0),
                v["cost_usd"].as_f64().unwrap_or(0.0),
                reason,
            ));
        }
        // Prepend so migrated rows sit before anything already written in the new format.
        let path = history_path(claude_dir);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, lines + &existing).is_ok() && fs::rename(&tmp, &path).is_ok() {
            let _ = fs::remove_file(&legacy);
        }
    }
    const LEGACY_PREFIXES: [&str; 5] = [
        "statusline-tokcache-", "statusline-session-", "statusline-state-", "statusline-renderer-", "statusline-rt-",
    ];
    for dir in [claude_dir, home_claude_dir] {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if LEGACY_PREFIXES.iter().any(|p| name.starts_with(p)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_file(std::env::temp_dir().join("claude-statusline-dashboard.html"));
}

fn home_claude_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".claude")
}

/// SessionEnd hook: stdin carries session_id, transcript_path and reason.
pub fn handle_hook_end() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let v: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let claude_dir = session::claude_dir();
    let now = session::now_secs();
    migrate_legacy(&claude_dir, &home_claude_dir());
    finalize(
        &claude_dir,
        v["session_id"].as_str().unwrap_or(""),
        v["transcript_path"].as_str().unwrap_or(""),
        v["reason"].as_str().unwrap_or("other"),
        now,
    );
    sweep_stale(&claude_dir, now);
}

const DASHBOARD: &str = include_str!("../dashboard-design/dashboard.html");

/// Writes the dashboard page next to history.js (only when its content changed) and returns it.
/// The page loads history.js itself, so nothing is regenerated per open.
pub fn install_dashboard(claude_dir: &Path) -> std::io::Result<PathBuf> {
    let page = claude_dir.join("statusline").join("dashboard.html");
    if fs::read(&page).ok().as_deref() != Some(DASHBOARD.as_bytes()) {
        fs::create_dir_all(claude_dir.join("statusline"))?;
        let tmp = page.with_extension("tmp");
        fs::write(&tmp, DASHBOARD)?;
        fs::rename(&tmp, &page)?;
    }
    Ok(page)
}

pub fn handle_history() {
    match install_dashboard(&session::claude_dir()) {
        Ok(page) if open::that(&page).is_ok() => println!("Dashboard opened: {}", page.display()),
        Ok(page) => println!("Dashboard saved: {}", page.display()),
        Err(err) => eprintln!("Failed to write dashboard: {err}"),
    }
}

#[cfg(test)]
#[path = "../tests/rust_unit/history_tests.rs"]
mod tests;
