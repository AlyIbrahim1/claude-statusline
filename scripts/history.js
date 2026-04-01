'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const open = require('open');

const JSONL_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || os.homedir(),
  '.claude',
  'statusline-history.jsonl'
);

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function readSessions() {
  if (!fs.existsSync(JSONL_PATH)) return [];
  try {
    return fs.readFileSync(JSONL_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

function writeSessions(sessions) {
  const tmp = JSONL_PATH + '.tmp';
  fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
  fs.writeFileSync(tmp, sessions.map(s => JSON.stringify(s)).join('\n') + '\n');
  fs.renameSync(tmp, JSONL_PATH);
}

function handleHookStart() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);
  const session = {
    session_id:       `pending-${projectName}-${Date.now()}`,
    project_dir:      projectDir,
    project_name:     projectName,
    model:            'pending',
    start_time:       now(),
    end_time:         now(),
    tokens_in:        0,
    tokens_out:       0,
    cost_usd:         0,
    duration_seconds: 0,
    exit_reason:      'pending',
  };
  try {
    fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
    fs.appendFileSync(JSONL_PATH, JSON.stringify(session) + '\n');
  } catch (e) {}
}

function handleHookEnd() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    let reason = 'unknown';
    try { reason = JSON.parse(input).reason || 'unknown'; } catch (e) {}

    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const slug = projectDir.replace(/[/\\]/g, '-');
    const projectsDir = path.join(home, '.claude', 'projects', slug);

    // Read session stats from the most recently modified JSONL in the project dir
    let sessionId = null;
    let totalIn = 0, totalOut = 0, cost = 0, model = '';

    if (fs.existsSync(projectsDir)) {
      try {
        let newestTime = 0, newestFile = null;
        for (const file of fs.readdirSync(projectsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const p = path.join(projectsDir, file);
          const mtime = fs.statSync(p).mtimeMs;
          if (mtime > newestTime) { newestTime = mtime; newestFile = p; }
        }
        if (newestFile) {
          sessionId = path.basename(newestFile, '.jsonl');
          const lines = fs.readFileSync(newestFile, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'assistant' && entry.message?.usage) {
                const u = entry.message.usage;
                totalIn  += (u.input_tokens || 0)
                  + Math.round((u.cache_read_input_tokens || 0) * 0.1)
                  + (u.cache_creation_input_tokens || 0);
                totalOut += (u.output_tokens || 0);
                if (!model) model = entry.message.model || '';
              } else if (entry.type === 'cost') {
                cost += (entry.cost_usd || 0);
              } else if (entry.type === 'message_start' && !model) {
                model = entry.message?.model || '';
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    if (!model) model = 'Claude';

    // Update the most recent pending session for this project
    try {
      const sessions = readSessions();
      let updatedIdx = -1;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].project_dir === projectDir && sessions[i].exit_reason === 'pending') {
          updatedIdx = i;
          break;
        }
      }

      if (updatedIdx !== -1) {
        const s = sessions[updatedIdx];
        const startMs = new Date(s.start_time.replace(' ', 'T') + 'Z').getTime();
        const durationSeconds = Math.round((Date.now() - startMs) / 1000);
        sessions[updatedIdx] = {
          ...s,
          session_id:       sessionId || s.session_id,
          model,
          end_time:         now(),
          tokens_in:        totalIn,
          tokens_out:       totalOut,
          cost_usd:         cost,
          duration_seconds: durationSeconds,
          exit_reason:      reason,
        };
        writeSessions(sessions);
      }
    } catch (e) {}

    process.exit(0);
  });
}

async function handleHistory() {
  const templatePath = path.join(__dirname, '../dashboard-design/dashboard.html');
  const cssPath      = path.join(__dirname, '../dashboard-design/styles.css');
  const jsPath       = path.join(__dirname, '../dashboard-design/script.js');

  const template = fs.readFileSync(templatePath, 'utf8');
  const css      = fs.readFileSync(cssPath,      'utf8');
  const js       = fs.readFileSync(jsPath,       'utf8');

  // Most-recent first, cap at 100
  const sessions = readSessions().reverse().slice(0, 100);
  const sessionsJson = JSON.stringify(sessions);

  // Inject CSS, JS, and data into the template using the sentinel strings
  const html = template
    .replace('/*INJECT_CSS*/', css)
    .replace('/*INJECT_DATA*/null', sessionsJson)
    .replace('/*INJECT_JS*/', js);

  const tempPath = path.join(os.tmpdir(), 'claude-statusline-dashboard.html');
  fs.writeFileSync(tempPath, html);
  try {
    await open.default(tempPath);
    console.log(`Dashboard opened: ${tempPath}`);
  } catch (e) {
    console.log(`Dashboard saved: ${tempPath}`);
  }
}

module.exports = { handleHookStart, handleHookEnd, handleHistory };
