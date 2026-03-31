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

fn fmt_tokens(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn fmt_duration(s: i64) -> String {
    if s >= 3600 {
        let h = s / 3600;
        let m = (s % 3600) / 60;
        if m > 0 { format!("{}h {}m", h, m) } else { format!("{}h", h) }
    } else if s >= 60 {
        format!("{}m", s / 60)
    } else {
        format!("{}s", s)
    }
}

const STATIC_HEAD: &str = r#"<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Statusline &#8212; Session History</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Calistoga&family=Plus+Jakarta+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
[data-theme="dark"] {
  --bg:             #1a1916;
  --bg-header:      rgba(26,25,22,0.88);
  --surface:        #242220;
  --surface-hover:  #2a2825;
  --surface-thead:  #1e1c1a;
  --border:         #3a3733;
  --border-subtle:  #302e2b;
  --accent:         #D4673C;
  --accent-mid:     rgba(212,103,60,0.14);
  --text:           #E8E2DA;
  --text-2:         #A09890;
  --text-3:         #6B6460;
  --green:          #4CAF84;
  --green-bg:       rgba(76,175,132,0.15);
  --amber:          #D4893A;
  --amber-bg:       rgba(212,137,58,0.15);
  --pending:        #A99ED4;
  --pending-bg:     rgba(169,158,212,0.15);
  --shadow-card:    0 1px 4px rgba(0,0,0,0.3), 0 0 0 1px var(--border);
  --shadow-md:      0 4px 16px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.2);
  --toggle-bg:      #3a3733;
  --toggle-knob:    #E8E2DA;
}
[data-theme="light"] {
  --bg:             #FAF9F6;
  --bg-header:      rgba(250,249,246,0.88);
  --surface:        #FFFFFF;
  --surface-hover:  #FDFCFA;
  --surface-thead:  #F4F2EE;
  --border:         #EAE4DD;
  --border-subtle:  #F0EBE5;
  --accent:         #C85A2E;
  --accent-mid:     rgba(200,90,46,0.10);
  --text:           #1C1410;
  --text-2:         #6B5D57;
  --text-3:         #9E8E87;
  --green:          #1F7A50;
  --green-bg:       rgba(31,122,80,0.10);
  --amber:          #925010;
  --amber-bg:       rgba(146,80,16,0.10);
  --pending:        #6B5FA8;
  --pending-bg:     rgba(107,95,168,0.10);
  --shadow-card:    0 1px 3px rgba(28,20,16,0.07), 0 0 0 1px var(--border);
  --shadow-md:      0 4px 16px rgba(28,20,16,0.10), 0 2px 4px rgba(28,20,16,0.06);
  --toggle-bg:      #EAE4DD;
  --toggle-knob:    #1C1410;
}
:root {
  --radius:      12px;
  --radius-sm:   8px;
  --radius-tag:  6px;
  --font-display:'Calistoga', Georgia, serif;
  --font-body:   'Plus Jakarta Sans', system-ui, sans-serif;
  --font-mono:   'JetBrains Mono', 'Courier New', monospace;
  --ease:        cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --header-h:    56px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background 0.25s var(--ease), color 0.25s var(--ease);
}
.header {
  position: sticky; top: 0; z-index: 100; height: var(--header-h);
  background: var(--bg-header); border-bottom: 1px solid var(--border);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  display: flex; align-items: center;
}
.header-inner {
  width: 100%; padding: 0 32px; display: flex;
  align-items: center; justify-content: space-between; gap: 16px;
}
.brand { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.brand-icon {
  width: 30px; height: 30px; border-radius: 7px; background: var(--accent);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: background 0.25s var(--ease);
}
.brand-icon svg { width: 16px; height: 16px; fill: #fff; }
.brand-name {
  font-family: var(--font-display); font-size: 17px; color: var(--text);
  letter-spacing: -0.01em; line-height: 1; transition: color 0.25s var(--ease);
}
.brand-name span { color: var(--accent); transition: color 0.25s var(--ease); }
.header-controls { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.filter-wrap { position: relative; }
.filter-select {
  appearance: none; -webkit-appearance: none; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-2);
  font-family: var(--font-body); font-size: 12px; font-weight: 500;
  padding: 6px 28px 6px 10px; cursor: pointer; outline: none;
  transition: border-color 0.15s, color 0.15s, background 0.25s var(--ease); min-width: 140px;
}
.filter-select:hover { border-color: var(--accent); color: var(--text); }
.filter-select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-mid); }
.filter-chevron {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  pointer-events: none; color: var(--text-3);
}
.gh-link {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface);
  color: var(--text-2); font-size: 12px; font-weight: 500; text-decoration: none;
  transition: border-color 0.15s, color 0.15s, background 0.25s var(--ease); white-space: nowrap;
}
.gh-link:hover { border-color: var(--accent); color: var(--text); }
.gh-link svg { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }
.theme-toggle {
  width: 40px; height: 22px; border-radius: 11px; background: var(--toggle-bg);
  border: none; cursor: pointer; position: relative; transition: background 0.25s var(--ease); flex-shrink: 0;
}
.theme-toggle::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--toggle-knob);
  transition: transform 0.25s var(--ease), background 0.25s var(--ease);
}
[data-theme="light"] .theme-toggle::after { transform: translateX(18px); }
.wrap { max-width: 1160px; margin: 0 auto; padding: 36px 28px 64px; }
.page-title { text-align: center; margin-bottom: 36px; }
.page-title h1 {
  font-family: var(--font-display); font-size: 28px; color: var(--text);
  letter-spacing: -0.02em; line-height: 1.1; transition: color 0.25s var(--ease);
}
.page-title p {
  font-size: 13px; color: var(--text-3); margin-top: 6px; font-weight: 400;
  transition: color 0.25s var(--ease);
}
.section-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-3); margin-bottom: 12px; transition: color 0.25s var(--ease);
}
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 36px; }
.card {
  background: var(--surface); box-shadow: var(--shadow-card); border-radius: var(--radius);
  padding: 22px 22px 18px;
  transition: box-shadow 0.2s var(--ease), transform 0.2s var(--ease), background 0.25s var(--ease);
  animation: fadeUp 0.4s var(--ease) both;
}
.card:nth-child(1) { animation-delay: 0.05s; }
.card:nth-child(2) { animation-delay: 0.10s; }
.card:nth-child(3) { animation-delay: 0.15s; }
.card:nth-child(4) { animation-delay: 0.20s; }
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.card:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.card-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-3); margin-bottom: 10px; transition: color 0.25s var(--ease);
}
.card-value { font-family: var(--font-mono); font-size: 26px; font-weight: 500; line-height: 1; letter-spacing: -0.02em; }
.card-value.coral { color: var(--accent); }
.card-value.amber { color: var(--amber); }
.card-value.green { color: var(--green); }
.card-sub { font-size: 12px; color: var(--text-3); margin-top: 8px; font-weight: 400; transition: color 0.25s var(--ease); }
.table-section { animation: fadeUp 0.4s var(--ease) 0.25s both; }
.table-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.table-title { font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; transition: color 0.25s var(--ease); }
.table-count {
  font-size: 12px; color: var(--text-3); background: var(--border-subtle);
  padding: 3px 10px; border-radius: 20px; font-weight: 500;
  transition: background 0.25s var(--ease), color 0.25s var(--ease);
}
.table-wrap {
  background: var(--surface); box-shadow: var(--shadow-card); border-radius: var(--radius);
  overflow: hidden; transition: background 0.25s var(--ease);
}
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 860px; }
thead tr { background: var(--surface-thead); border-bottom: 2px solid var(--border); }
thead th {
  padding: 12px 16px; text-align: left; font-size: 10px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-3); white-space: nowrap;
  transition: background 0.25s var(--ease), color 0.25s var(--ease);
}
thead th:first-child { color: var(--accent); opacity: 0.8; }
tbody tr { border-bottom: 1px solid var(--border-subtle); transition: background 0.12s var(--ease); }
tbody tr:last-child { border-bottom: none; }
tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
[data-theme="light"] tbody tr:nth-child(even) { background: rgba(0,0,0,0.015); }
tbody tr:hover { background: var(--accent-mid); }
tbody td { padding: 11px 16px; font-size: 13px; white-space: nowrap; }
.tag {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border-radius: var(--radius-tag); background: var(--accent-mid); color: var(--accent);
  font-size: 12px; font-weight: 600; letter-spacing: -0.01em; max-width: 160px;
  overflow: hidden; text-overflow: ellipsis;
  transition: background 0.25s var(--ease), color 0.25s var(--ease);
}
.tag::before {
  content: ''; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; opacity: 0.6; flex-shrink: 0;
}
.col-model { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }
.col-ts    { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.col-dur   { font-family: var(--font-mono); font-size: 12px; color: var(--text); font-weight: 500; }
.col-tok   { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--amber); }
.col-cost  { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--green); }
.reason-badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.reason-badge.normal    { background: var(--green-bg);      color: var(--green); }
.reason-badge.interrupt { background: var(--amber-bg);      color: var(--amber); }
.reason-badge.pending   { background: var(--pending-bg);    color: var(--pending); font-style: italic; }
.reason-badge.unknown   { background: var(--border-subtle); color: var(--text-3); }
@media (max-width: 840px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
  .wrap  { padding: 24px 16px 48px; }
  .header-inner { padding: 0 16px; }
  .gh-link span { display: none; }
}
@media (max-width: 600px) {
  .filter-select { min-width: 110px; }
  .brand-name { font-size: 15px; }
}
@media (prefers-reduced-motion: reduce) {
  .card, .table-section { animation: none; }
  .card:hover { transform: none; }
  * { transition-duration: 0ms !important; }
}
tbody tr.hidden { display: none; }
</style>
</head>
<body>"#;

const STATIC_SCRIPT: &str = r#"<script>
const toggle = document.getElementById('themeToggle');
const html = document.documentElement;
html.setAttribute('data-theme', localStorage.getItem('theme') || 'dark');
toggle.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

const filter   = document.getElementById('projectFilter');
const rows     = document.querySelectorAll('#tableBody tr');
const countEl  = document.getElementById('rowCount');
const statSessions = document.getElementById('statSessions');
const statTokIn    = document.getElementById('statTokIn');
const statTokOut   = document.getElementById('statTokOut');
const statCost     = document.getElementById('statCost');

function applyFilter() {
  const val = filter.value;
  let sessions = 0, tokIn = 0, tokOut = 0, cost = 0, visible = 0;
  rows.forEach(row => {
    const match = !val || row.dataset.project === val;
    row.classList.toggle('hidden', !match);
    if (match) {
      visible++;
      if (row.dataset.pending !== '1') {
        sessions++;
        tokIn  += Number(row.dataset.tokIn)  || 0;
        tokOut += Number(row.dataset.tokOut) || 0;
        cost   += Number(row.dataset.cost)   || 0;
      }
    }
  });
  countEl.textContent      = visible + ' entr' + (visible === 1 ? 'y' : 'ies');
  statSessions.textContent = sessions;
  statTokIn.textContent    = fmtTokens(tokIn);
  statTokOut.textContent   = fmtTokens(tokOut);
  statCost.textContent     = '$' + cost.toFixed(2);
}

filter.addEventListener('change', applyFilter);
</script>
</body>
</html>"#;

pub fn handle_history() {
    if let Ok(conn) = init_db() {
        // Collect distinct project names for the filter dropdown
        let project_options = conn
            .prepare("SELECT DISTINCT project_name FROM sessions ORDER BY project_name")
            .ok()
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(0))
                    .ok()
                    .map(|iter| {
                        iter.flatten()
                            .map(|name| format!("<option value=\"{name}\">{name}</option>"))
                            .collect::<Vec<_>>()
                            .join("\n          ")
                    })
            })
            .unwrap_or_default();

        let mut stmt = match conn.prepare(
            "SELECT project_name, model, start_time, duration_seconds, tokens_in, tokens_out, cost_usd, exit_reason \
             FROM sessions ORDER BY start_time DESC LIMIT 100"
        ) {
            Ok(s) => s,
            Err(_) => {
                let html = format!(
                    "{}\n<main class=\"wrap\" style=\"padding:48px 28px\">\
                     <p style=\"color:var(--accent);font-family:var(--font-mono);font-size:14px\">\
                     Failed to load session database.</p></main>\n{}",
                    STATIC_HEAD, STATIC_SCRIPT
                );
                let path = std::env::temp_dir().join("claude-statusline-dashboard.html");
                if fs::write(&path, &html).is_ok() { let _ = open::that(&path); }
                return;
            }
        };

        let mut total_cost = 0.0_f64;
        let mut total_in = 0_i64;
        let mut total_out = 0_i64;
        let mut session_count = 0_usize;
        let mut row_count = 0_usize;

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
                let is_pending = session.7 == "pending";
                row_count += 1;
                if !is_pending {
                    total_cost += session.6;
                    total_in += session.4;
                    total_out += session.5;
                    session_count += 1;
                }
                let badge_class = match session.7.as_str() {
                    "normal"    => "reason-badge normal",
                    "interrupt" => "reason-badge interrupt",
                    "pending"   => "reason-badge pending",
                    _           => "reason-badge unknown",
                };
                let (dur_cell, tok_in_cell, tok_out_cell, cost_cell,
                     data_ti, data_to, data_cost_attr, data_pending) = if is_pending {
                    ("\u{2014}".to_string(), "\u{2014}".to_string(),
                     "\u{2014}".to_string(), "\u{2014}".to_string(),
                     "0".to_string(), "0".to_string(), "0".to_string(), "1")
                } else {
                    (fmt_duration(session.3), fmt_tokens(session.4), fmt_tokens(session.5),
                     format!("${:.4}", session.6),
                     session.4.to_string(), session.5.to_string(),
                     format!("{:.4}", session.6), "0")
                };
                rows_html.push_str(&format!(
                    "<tr data-project=\"{proj}\" data-tok-in=\"{ti}\" data-tok-out=\"{to}\" \
                       data-cost=\"{c}\" data-pending=\"{p}\">\
                      <td><span class=\"tag\">{proj}</span></td>\
                      <td class=\"col-model\">{model}</td>\
                      <td class=\"col-ts\">{ts}</td>\
                      <td class=\"col-dur\">{dur}</td>\
                      <td class=\"col-tok\">{tok_in}</td>\
                      <td class=\"col-tok\">{tok_out}</td>\
                      <td class=\"col-cost\">{cost}</td>\
                      <td><span class=\"{badge}\">{reason}</span></td>\
                    </tr>",
                    proj = session.0, model = session.1, ts = session.2,
                    dur = dur_cell, tok_in = tok_in_cell, tok_out = tok_out_cell, cost = cost_cell,
                    badge = badge_class, reason = session.7,
                    ti = data_ti, to = data_to, c = data_cost_attr, p = data_pending
                ));
            }
        }

        let empty_row = if rows_html.is_empty() {
            "<tr><td colspan=\"8\" style=\"text-align:center;padding:48px 20px;\
             color:var(--text-3);font-size:13px;\">No sessions recorded yet</td></tr>".to_string()
        } else {
            String::new()
        };

        let row_count_str = format!("{} entr{}", row_count, if row_count == 1 { "y" } else { "ies" });

        let header_html = format!(
            "<header class=\"header\">\n  <div class=\"header-inner\">\n\
               <div class=\"brand\">\n\
                 <div class=\"brand-icon\">\
                   <svg viewBox=\"0 0 18 18\" xmlns=\"http://www.w3.org/2000/svg\">\
                     <path d=\"M9 1.5C4.86 1.5 1.5 4.86 1.5 9s3.36 7.5 7.5 7.5 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5zm0 2.5a5 5 0 110 10A5 5 0 019 4zm0 2a3 3 0 100 6 3 3 0 000-6z\"/>\
                   </svg></div>\n\
                 <div class=\"brand-name\">claude<span>.</span>statusline</div>\n\
               </div>\n\
               <div class=\"header-controls\">\n\
                 <div class=\"filter-wrap\">\
                   <select class=\"filter-select\" id=\"projectFilter\" aria-label=\"Filter by project\">\
                     <option value=\"\">All projects</option>\n          {po}\
                   </select>\
                   <svg class=\"filter-chevron\" width=\"10\" height=\"10\" viewBox=\"0 0 10 10\" fill=\"none\">\
                     <path d=\"M2 3.5L5 6.5L8 3.5\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\
                   </svg></div>\n\
                 <a class=\"gh-link\" href=\"https://github.com/alyibrahim/claude-statusline\" target=\"_blank\" rel=\"noopener\" aria-label=\"GitHub repository\">\
                   <svg viewBox=\"0 0 16 16\" xmlns=\"http://www.w3.org/2000/svg\">\
                     <path d=\"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z\"/>\
                   </svg><span>GitHub</span></a>\n\
                 <button class=\"theme-toggle\" id=\"themeToggle\" aria-label=\"Toggle dark/light mode\" title=\"Toggle theme\"></button>\n\
               </div>\n\
             </div>\n</header>",
            po = project_options
        );

        let cards_html = format!(
            "<div class=\"cards\">\n\
               <div class=\"card\"><div class=\"card-label\">Sessions</div>\
                 <div class=\"card-value coral\" id=\"statSessions\">{sc}</div>\
                 <div class=\"card-sub\">recorded</div></div>\n\
               <div class=\"card\"><div class=\"card-label\">Tokens In</div>\
                 <div class=\"card-value amber\" id=\"statTokIn\">{ti}</div>\
                 <div class=\"card-sub\">input tokens</div></div>\n\
               <div class=\"card\"><div class=\"card-label\">Tokens Out</div>\
                 <div class=\"card-value amber\" id=\"statTokOut\">{to}</div>\
                 <div class=\"card-sub\">output tokens</div></div>\n\
               <div class=\"card\"><div class=\"card-label\">Total Spend</div>\
                 <div class=\"card-value green\" id=\"statCost\">${tc}</div>\
                 <div class=\"card-sub\">USD</div></div>\n\
             </div>",
            sc = session_count,
            ti = fmt_tokens(total_in),
            to = fmt_tokens(total_out),
            tc = format!("{:.2}", total_cost)
        );

        let table_html = format!(
            "<div class=\"table-section\">\n\
               <div class=\"table-header\">\
                 <div class=\"table-title\">Session Log</div>\
                 <div class=\"table-count\" id=\"rowCount\">{rc}</div>\
               </div>\n\
               <div class=\"table-wrap\"><div class=\"table-scroll\">\
                 <table>\
                   <thead><tr>\
                     <th>Project</th><th>Model</th><th>Start Time</th><th>Duration</th>\
                     <th>Tokens In</th><th>Tokens Out</th><th>Cost</th><th>Reason</th>\
                   </tr></thead>\
                   <tbody id=\"tableBody\">{rows}{empty}</tbody>\
                 </table>\
               </div></div>\n\
             </div>",
            rc    = row_count_str,
            rows  = rows_html,
            empty = empty_row
        );

        let html = format!(
            "{head}\n{header}\n<main class=\"wrap\">\
             <div class=\"page-title\"><h1>Session History</h1>\
             <p>Claude Code usage across all projects</p></div>\
             <div class=\"section-label\">Overview</div>\
             {cards}{table}</main>\n{script}",
            head   = STATIC_HEAD,
            header = header_html,
            cards  = cards_html,
            table  = table_html,
            script = STATIC_SCRIPT
        );

        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("claude-statusline-dashboard.html");
        if fs::write(&file_path, html).is_ok() {
            let _ = open::that(&file_path);
            println!("Opened dashboard at {}", file_path.display());
        } else {
            println!("Failed to write dashboard HTML file.");
        }
    } else {
        let html = format!(
            "{}\n<main class=\"wrap\" style=\"padding:48px 28px\">\
             <p style=\"color:var(--accent);font-family:var(--font-mono);font-size:14px\">\
             Failed to load session database.</p></main>\n{}",
            STATIC_HEAD, STATIC_SCRIPT
        );
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("claude-statusline-dashboard.html");
        if fs::write(&file_path, &html).is_ok() {
            let _ = open::that(&file_path);
        } else {
            println!("Failed to write dashboard HTML file.");
        }
    }
}
