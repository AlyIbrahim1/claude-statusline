use std::path::{Path, PathBuf};
use rusqlite::{Connection, Result};
use std::env;
use std::fs;
use std::io::Read;

fn get_db_path() -> PathBuf {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".claude").join("statusline-history.db")
}

fn init_db() -> Result<Connection> {
    let db_path = get_db_path();
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE NOT NULL,
            project_dir TEXT NOT NULL,
            project_name TEXT NOT NULL,
            model TEXT NOT NULL,
            start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            end_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            tokens_in INTEGER DEFAULT 0,
            tokens_out INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0.0,
            duration_seconds INTEGER DEFAULT 0,
            exit_reason TEXT 
        )",
        [],
    )?;
    Ok(conn)
}

pub fn handle_hook_start() {
    let project_dir = env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    });
    let project_name = Path::new(&project_dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    
    // We insert a pending session with a placeholder session_id 
    // since session_id is UNIQUE, we use a random/timestamp combo.
    // However, since Claude Code doesn't give us the ID here, we use a temporary key.
    // When the session ends, we'll update the MOST RECENT pending session in this dir.
    let temp_session_id = format!("pending-{}-{}", project_name, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());

    if let Ok(conn) = init_db() {
        let _ = conn.execute(
            "INSERT INTO sessions (session_id, project_dir, project_name, model, exit_reason) VALUES (?, ?, ?, ?, ?)",
            (&temp_session_id, &project_dir, &project_name, "pending", "pending"),
        );
    }
}

pub fn handle_hook_end() {
    // Read stdin for exit reason
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let reason = serde_json::from_str::<serde_json::Value>(&input)
        .ok()
        .and_then(|v| v["reason"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".to_string());

    let project_dir = env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    });
    
    // Find the newest JSONL file in ~/.claude/projects/<slug>/
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    
    // Slug computation matches JS: absDir.replace(/\//g, '-')
    // Wait, on windows backslashes are used. We should replace both / and \ with -
    let slug = project_dir.replace('/', "-").replace('\\', "-");
    let projects_dir = PathBuf::from(&home).join(".claude").join("projects").join(&slug);
    
    let mut newest_file = None;
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

    if let Some(jsonl_path) = newest_file {
        // read totals
        let session_id = jsonl_path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let mut total_in = 0;
        let mut total_out = 0;
        let mut cost = 0.0;
        let mut model = String::new();

        if let Ok(content) = fs::read_to_string(&jsonl_path) {
            for line in content.split('\n') {
                if line.trim().is_empty() { continue; }
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                    if entry["type"] == "assistant" {
                        if let Some(usage) = entry["message"]["usage"].as_object() {
                            total_in += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                                + (usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) / 10)
                                + usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total_out += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        }
                        if model.is_empty() {
                            model = entry["message"]["model"].as_str().unwrap_or("Claude").to_string();
                        }
                    } else if entry["type"] == "cost" {
                        cost += entry["cost_usd"].as_f64().unwrap_or(0.0);
                    } else if entry["type"] == "message_start" {
                        if model.is_empty() {
                            model = entry["message"]["model"].as_str().unwrap_or("Claude").to_string();
                        }
                    }
                }
            }
        }

        if model.is_empty() {
            model = "Claude".to_string();
        }

        // update DB: find the most recent 'pending' session for this project, OR upsert.
        if let Ok(conn) = init_db() {
            let _ = conn.execute(
                "UPDATE sessions 
                 SET session_id = ?1, model = ?2, end_time = CURRENT_TIMESTAMP, 
                     tokens_in = ?3, tokens_out = ?4, cost_usd = ?5, exit_reason = ?6,
                     duration_seconds = CAST(strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', start_time) AS INTEGER)
                 WHERE id = (SELECT id FROM sessions WHERE project_dir = ?7 AND exit_reason = 'pending' ORDER BY start_time DESC LIMIT 1)",
                rusqlite::params![session_id, model, total_in, total_out, cost, reason, project_dir],
            );
            // If no rows were updated (e.g. they started a session without the hook), maybe insert directly.
            // For now, hook start initializes it properly if enabled.
        }
    }
}

pub fn handle_history() {
    let mut html = String::from("<!DOCTYPE html><html><head><meta charset=\"UTF-8\">");
    html.push_str("<title>Claude Statusline History</title>");
    html.push_str("<style>
        body { font-family: 'Inter', sans-serif; background: #121212; color: #eee; margin: 0; padding: 40px; }
        h1 { font-size: 24px; font-weight: 600; margin-bottom: 20px; color: #fff; }
        .dashboard { max-width: 1000px; margin: 0 auto; }
        .totals { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { background: #1e1e1e; padding: 20px; border-radius: 12px; flex: 1; border: 1px solid #333; }
        .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
        .card p { margin: 0; font-size: 28px; font-weight: 600; color: #fff; }
        table { width: 100%; border-collapse: collapse; background: #1e1e1e; border-radius: 12px; overflow: hidden; border: 1px solid #333; }
        th, td { padding: 15px; text-align: left; border-bottom: 1px solid #333; }
        th { background: #252525; color: #aaa; font-weight: 500; font-size: 13px; text-transform: uppercase; }
        tr:last-child td { border-bottom: none; }
        .badge { background: #2b3a4a; color: #61afef; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
        .model { color: #98c379; }
        .tokens { font-family: monospace; color: #e5c07b; }
        .cost { color: #d19a66; }
    </style></head><body>");

    html.push_str("<div class='dashboard'><h1>Claude Statusline Analytics</h1>");

    if let Ok(conn) = init_db() {
        let mut stmt = conn.prepare("SELECT project_name, model, start_time, duration_seconds, tokens_in, tokens_out, cost_usd, exit_reason FROM sessions ORDER BY start_time DESC LIMIT 100").unwrap();
        
        let mut total_cost = 0.0;
        let mut total_in = 0;
        let mut total_out = 0;
        
        let session_iter = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, String>(7)?,
            ))
        });

        let mut rows_html = String::new();
        if let Ok(iter) = session_iter {
            for session in iter.flatten() {
                if session.7 != "pending" {
                    total_cost += session.6;
                    total_in += session.4;
                    total_out += session.5;
                }
                
                rows_html.push_str(&format!(
                    "<tr>
                        <td><span class='badge'>{}</span></td>
                        <td class='model'>{}</td>
                        <td>{}</td>
                        <td>{}s</td>
                        <td class='tokens'>{}↓ {}↑</td>
                        <td class='cost'>${:.4}</td>
                        <td>{}</td>
                    </tr>",
                    session.0, session.1, session.2, session.3, session.4, session.5, session.6, session.7
                ));
            }
        }

        html.push_str(&format!(
            "<div class='totals'>
                <div class='card'><h3>Total Input Tokens</h3><p>{}</p></div>
                <div class='card'><h3>Total Output Tokens</h3><p>{}</p></div>
                <div class='card'><h3>Total Spend</h3><p>${:.2}</p></div>
            </div>",
            total_in, total_out, total_cost
        ));

        html.push_str("<table><thead><tr>
            <th>Project</th><th>Model</th><th>Start Time</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Reason</th>
        </tr></thead><tbody>");
        html.push_str(&rows_html);
        html.push_str("</tbody></table></div></body></html>");
    } else {
        html.push_str("<p>Failed to load database.</p></div></body></html>");
    }

    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join("claude-statusline-dashboard.html");
    if fs::write(&file_path, html).is_ok() {
        let _ = open::that(&file_path);
        println!("Opened dashboard at {}", file_path.display());
    } else {
        println!("Failed to write dashboard HTML file.");
    }
}
