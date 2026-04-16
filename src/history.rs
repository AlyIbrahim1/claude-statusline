use std::path::PathBuf;
use std::env;
use std::fs;
use std::io::{Read, Write};
use serde_json::{Value, json};

fn home_dir_string() -> String {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}

fn get_jsonl_path() -> PathBuf {
    let home = home_dir_string();
    PathBuf::from(home).join(".claude").join("statusline-history.jsonl")
}

/// Returns current UTC time as "YYYY-MM-DD HH:MM:SS".
fn now_str() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_secs_to_str(secs)
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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

fn read_sessions(path: &PathBuf) -> Vec<Value> {
    if !path.exists() { return vec![]; }
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn write_sessions(path: &PathBuf, sessions: &[Value]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("tmp");
    let content: String = sessions.iter()
        .filter_map(|s| serde_json::to_string(s).ok())
        .collect::<Vec<_>>()
        .join("\n") + "\n";
    if fs::write(&tmp, &content).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

fn append_session(path: &PathBuf, session: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(session) {
            let _ = writeln!(file, "{}", line);
        }
    }
}

pub fn handle_hook_start() {
    let project_dir = env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    });
    let project_name = std::path::Path::new(&project_dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_id = format!("pending-{}-{}", project_name, ts_ms);
    let now = now_str();

    let session = json!({
        "session_id":       temp_id,
        "project_dir":      project_dir,
        "project_name":     project_name,
        "model":            "pending",
        "start_time":       now,
        "end_time":         now,
        "tokens_in":        0,
        "tokens_out":       0,
        "cost_usd":         0.0,
        "duration_seconds": 0,
        "exit_reason":      "pending"
    });

    append_session(&get_jsonl_path(), &session);
}

pub fn handle_hook_end() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let reason = serde_json::from_str::<Value>(&input)
        .ok()
        .and_then(|v| v["reason"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".to_string());

    let project_dir = env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    });

    // Find the newest JSONL file in ~/.claude/projects/<slug>/
    let home = home_dir_string();
    let slug = project_dir.replace(['/', '\\'], "-");
    let projects_dir = PathBuf::from(&home).join(".claude").join("projects").join(&slug);

    let mut newest_file: Option<PathBuf> = None;
    let mut newest_time = std::time::UNIX_EPOCH;

    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified > newest_time {
                            newest_time = modified;
                            newest_file = Some(path);
                        }
                    }
                }
            }
        }
    }

    let mut session_id = String::new();
    let mut total_in:  u64 = 0;
    let mut total_out: u64 = 0;
    let mut cost = 0.0_f64;
    let mut model = String::new();

    if let Some(jsonl_path) = newest_file {
        session_id = jsonl_path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();

        if let Ok(content) = fs::read_to_string(&jsonl_path) {
            for line in content.lines() {
                if line.trim().is_empty() { continue; }
                if let Ok(entry) = serde_json::from_str::<Value>(line) {
                    if entry["type"] == "assistant" {
                        if let Some(usage) = entry["message"]["usage"].as_object() {
                            total_in += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                                // Keep parity with JS: Math.round(cache_read_input_tokens * 0.1)
                                + (usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0).saturating_add(5) / 10)
                                + usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total_out += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        }
                        if model.is_empty() {
                            model = entry["message"]["model"].as_str().unwrap_or("").to_string();
                        }
                    } else if entry["type"] == "cost" {
                        cost += entry["cost_usd"].as_f64().unwrap_or(0.0);
                    } else if entry["type"] == "message_start" && model.is_empty() {
                        model = entry["message"]["model"].as_str().unwrap_or("").to_string();
                    }
                }
            }
        }
    }

    if model.is_empty() { model = "Claude".to_string(); }

    // Update the most recent pending session for this project
    let jsonl_path = get_jsonl_path();
    let mut sessions = read_sessions(&jsonl_path);

    if let Some(idx) = sessions.iter().rposition(|s| {
        s["project_dir"].as_str() == Some(&project_dir) && s["exit_reason"] == "pending"
    }) {
        let start_str = sessions[idx]["start_time"].as_str().unwrap_or("").to_string();
        let duration_seconds = parse_datetime_to_unix_secs(&start_str)
            .map(|start| now_unix_secs().saturating_sub(start) as i64)
            .unwrap_or(0);

        sessions[idx]["session_id"]       = json!(if session_id.is_empty() { sessions[idx]["session_id"].as_str().unwrap_or("").to_string() } else { session_id });
        sessions[idx]["model"]            = json!(model);
        sessions[idx]["end_time"]         = json!(now_str());
        sessions[idx]["tokens_in"]        = json!(total_in);
        sessions[idx]["tokens_out"]       = json!(total_out);
        sessions[idx]["cost_usd"]         = json!(cost);
        sessions[idx]["duration_seconds"] = json!(duration_seconds);
        sessions[idx]["exit_reason"]      = json!(reason);

        write_sessions(&jsonl_path, &sessions);
    }
}

pub fn handle_history() {
    // Embed the dashboard-design files at compile time.
    // Any UI change in dashboard-design/ is automatically picked up on next build.
    let template = include_str!("../dashboard-design/dashboard.html");
    let css      = include_str!("../dashboard-design/styles.css");
    let js       = include_str!("../dashboard-design/script.js");

    let jsonl_path   = get_jsonl_path();
    let all_sessions = read_sessions(&jsonl_path);
    // Most-recent first, cap at 100
    let sessions: Vec<&Value> = all_sessions.iter().rev().take(100).collect();

    // Serialize the session array to JSON for client-side rendering
    let sessions_json = serde_json::to_string(&sessions).unwrap_or_else(|_| "[]".to_string());

    // Inline the external CSS/JS links and inject session data.
    // dashboard.html uses real <link>/<script src> so it opens directly in a browser during development.
    // At runtime we replace those tags with inlined content to produce a self-contained file.
    let html = template
        .replace(r#"<link rel="stylesheet" href="styles.css">"#, &format!("<style>{css}</style>"))
        .replace("/*INJECT_DATA*/null", &sessions_json)
        .replace(r#"<script src="script.js"></script>"#, &format!("<script>{js}</script>"));

    let file_path = std::env::temp_dir().join("claude-statusline-dashboard.html");
    if fs::write(&file_path, &html).is_ok() {
        if open::that(&file_path).is_ok() {
            println!("Dashboard opened: {}", file_path.display());
        } else {
            println!("Dashboard saved: {}", file_path.display());
        }
    } else {
        eprintln!("Failed to write dashboard HTML file.");
    }
}

#[cfg(test)]
#[path = "../tests/rust_unit/history_tests.rs"]
mod tests;
