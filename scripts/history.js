const fs = require('fs');
const path = require('path');
const os = require('os');
const open = require('open');

// Returns undefined if better-sqlite3 is not available
function getDb() {
  try {
    const Database = require('better-sqlite3');
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    const dbDir = path.join(home, '.claude');
    fs.mkdirSync(dbDir, { recursive: true });
    
    const db = new Database(path.join(dbDir, 'statusline-history.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
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
      )
    `);
    return db;
  } catch (e) {
    return null;
  }
}

function handleHookStart() {
  const db = getDb();
  if (!db) return; // Silent fallback

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);
  const tempSessionId = `pending-${projectName}-${Date.now()}`;

  try {
    const stmt = db.prepare('INSERT INTO sessions (session_id, project_dir, project_name, model, exit_reason) VALUES (?, ?, ?, ?, ?)');
    stmt.run(tempSessionId, projectDir, projectName, 'pending', 'pending');
  } catch (e) {}
}

function handleHookEnd() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const db = getDb();
    if (!db) return process.exit(0);

    let reason = 'unknown';
    try {
      const data = JSON.parse(input);
      reason = data.reason || 'unknown';
    } catch(e) {}

    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    const slug = projectDir.replace(/[\/\\]/g, '-');
    const projectsDir = path.join(home, '.claude', 'projects', slug);

    let newestFile = null;
    let newestTime = 0;

    if (fs.existsSync(projectsDir)) {
      try {
        const files = fs.readdirSync(projectsDir);
        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const p = path.join(projectsDir, file);
            const mtime = fs.statSync(p).mtimeMs;
            if (mtime > newestTime) {
              newestTime = mtime;
              newestFile = p;
            }
          }
        }
      } catch(e) {}
    }

    if (newestFile) {
      const sessionId = path.basename(newestFile, '.jsonl');
      let totalIn = 0;
      let totalOut = 0;
      let cost = 0.0;
      let model = '';

      try {
        const content = fs.readFileSync(newestFile, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'assistant' && entry.message?.usage) {
              const u = entry.message.usage;
              totalIn += (u.input_tokens || 0) + Math.round((u.cache_read_input_tokens || 0) * 0.1) + (u.cache_creation_input_tokens || 0);
              totalOut += (u.output_tokens || 0);
              if (!model) model = entry.message.model || 'Claude';
            } else if (entry.type === 'cost') {
              cost += (entry.cost_usd || 0.0);
            } else if (entry.type === 'message_start' && !model) {
              model = entry.message?.model || 'Claude';
            }
          } catch(e) {}
        }
      } catch(e) {}

      if (!model) model = 'Claude';

      try {
        const stmt = db.prepare(`
          UPDATE sessions 
          SET session_id = ?, model = ?, end_time = CURRENT_TIMESTAMP, 
              tokens_in = ?, tokens_out = ?, cost_usd = ?, exit_reason = ?,
              duration_seconds = CAST((julianday('now') - julianday(start_time)) * 86400 as integer)
          WHERE id = (SELECT id FROM sessions WHERE project_dir = ? AND exit_reason = 'pending' ORDER BY start_time DESC LIMIT 1)
        `);
        stmt.run(sessionId, model, totalIn, totalOut, cost, reason, projectDir);
      } catch (e) {}
    }
    process.exit(0);
  });
}

async function handleHistory() {
  const db = getDb();
  if (!db) {
    console.error('SQLite is not available. Please install @alyibrahim/claude-statusline with native modules, or ensure better-sqlite3 is successfully installed.');
    process.exit(1);
  }

  let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Claude Statusline History</title>';
  html += `<style>
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
  </style></head><body>`;

  html += `<div class="dashboard"><h1>Claude Statusline Analytics</h1>`;
  
  try {
    const rows = db.prepare('SELECT project_name, model, start_time, duration_seconds, tokens_in, tokens_out, cost_usd, exit_reason FROM sessions ORDER BY start_time DESC LIMIT 100').all();
    let totalCost = 0.0, totalIn = 0, totalOut = 0;
    
    let rowsHtml = '';
    for (const s of rows) {
      if (s.exit_reason !== 'pending') {
        totalCost += (s.cost_usd || 0);
        totalIn += (s.tokens_in || 0);
        totalOut += (s.tokens_out || 0);
      }
      rowsHtml += `<tr>
        <td><span class="badge">${s.project_name}</span></td>
        <td class="model">${s.model}</td>
        <td>${s.start_time}</td>
        <td>${s.duration_seconds}s</td>
        <td class="tokens">${s.tokens_in}↓ ${s.tokens_out}↑</td>
        <td class="cost">$${Number(s.cost_usd).toFixed(4)}</td>
        <td>${s.exit_reason}</td>
      </tr>`;
    }

    html += `<div class="totals">
      <div class="card"><h3>Total Input Tokens</h3><p>${totalIn}</p></div>
      <div class="card"><h3>Total Output Tokens</h3><p>${totalOut}</p></div>
      <div class="card"><h3>Total Spend</h3><p>$${totalCost.toFixed(2)}</p></div>
    </div>`;

    html += `<table><thead><tr>
      <th>Project</th><th>Model</th><th>Start Time</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Reason</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table></div></body></html>`;

    const tempPath = path.join(os.tmpdir(), 'claude-statusline-dashboard.html');
    fs.writeFileSync(tempPath, html);
    
    console.log(`Opened dashboard at ${tempPath}`);
    await open(tempPath);
  } catch (e) {
    console.error(`Failed to load database: ${e.message}`);
  }
}

module.exports = { handleHookStart, handleHookEnd, handleHistory };
