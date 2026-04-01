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
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  function dur(s) {
    s = Number(s) || 0;
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    if (s >= 60) return `${Math.floor(s / 60)}m`;
    return `${s}s`;
  }

  const allSessions = readSessions().reverse().slice(0, 100);

  const projectNames = [...new Set(allSessions.map(s => s.project_name))].sort();
  const projectOptions = projectNames
    .map(p => `<option value="${p}">${p}</option>`)
    .join('\n          ');

  let totalCost = 0, totalIn = 0, totalOut = 0, sessionCount = 0;
  let rowsHtml = '';

  for (const s of allSessions) {
    if (s.exit_reason !== 'pending') {
      totalCost += (s.cost_usd || 0);
      totalIn   += (s.tokens_in  || 0);
      totalOut  += (s.tokens_out || 0);
      sessionCount++;
    }
    const isPending   = s.exit_reason === 'pending';
    const badgeClass  = { normal: 'reason-badge normal', interrupt: 'reason-badge interrupt', pending: 'reason-badge pending' }[s.exit_reason] ?? 'reason-badge unknown';
    const durCell     = isPending ? '\u2014' : dur(s.duration_seconds);
    const tokInCell   = isPending ? '\u2014' : fmt(s.tokens_in);
    const tokOutCell  = isPending ? '\u2014' : fmt(s.tokens_out);
    const costCell    = isPending ? '\u2014' : `$${Number(s.cost_usd).toFixed(4)}`;

    rowsHtml += `
          <tr data-project="${s.project_name}" data-tok-in="${isPending ? 0 : s.tokens_in}" data-tok-out="${isPending ? 0 : s.tokens_out}" data-cost="${isPending ? 0 : s.cost_usd}" data-pending="${isPending ? 1 : 0}">
            <td><span class="tag">${s.project_name}</span></td>
            <td class="col-model">${s.model}</td>
            <td class="col-ts">${s.start_time}</td>
            <td class="col-dur">${durCell}</td>
            <td class="col-tok">${tokInCell}</td>
            <td class="col-tok">${tokOutCell}</td>
            <td class="col-cost">${costCell}</td>
            <td><span class="${badgeClass}">${s.exit_reason}</span></td>
          </tr>`;
  }

  const rowCount = allSessions.length;
  const emptyRow = rowsHtml ? '' : '<tr><td colspan="8" style="text-align:center;padding:48px 20px;color:var(--text-3);font-size:13px;">No sessions recorded yet</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Statusline \u2014 Session History</title>
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
  position: sticky;
  top: 0;
  z-index: 100;
  height: var(--header-h);
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
}
.header-inner {
  width: 100%;
  padding: 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
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
  appearance: none; -webkit-appearance: none;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-2); font-family: var(--font-body); font-size: 12px; font-weight: 500;
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
<body>

<header class="header">
  <div class="header-inner">
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9s3.36 7.5 7.5 7.5 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5zm0 2.5a5 5 0 110 10A5 5 0 019 4zm0 2a3 3 0 100 6 3 3 0 000-6z"/>
        </svg>
      </div>
      <div class="brand-name">claude<span>.</span>statusline</div>
    </div>
    <div class="header-controls">
      <div class="filter-wrap">
        <select class="filter-select" id="projectFilter" aria-label="Filter by project">
          <option value="">All projects</option>
          ${projectOptions}
        </select>
        <svg class="filter-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <a class="gh-link" href="https://github.com/alyibrahim/claude-statusline" target="_blank" rel="noopener" aria-label="GitHub repository">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        <span>GitHub</span>
      </a>
      <button class="theme-toggle" id="themeToggle" aria-label="Toggle dark/light mode" title="Toggle theme"></button>
    </div>
  </div>
</header>

<main class="wrap">
  <div class="page-title">
    <h1>Session History</h1>
    <p>Claude Code usage across all projects</p>
  </div>
  <div class="section-label">Overview</div>
  <div class="cards">
    <div class="card">
      <div class="card-label">Sessions</div>
      <div class="card-value coral" id="statSessions">${sessionCount}</div>
      <div class="card-sub">recorded</div>
    </div>
    <div class="card">
      <div class="card-label">Tokens In</div>
      <div class="card-value amber" id="statTokIn">${fmt(totalIn)}</div>
      <div class="card-sub">input tokens</div>
    </div>
    <div class="card">
      <div class="card-label">Tokens Out</div>
      <div class="card-value amber" id="statTokOut">${fmt(totalOut)}</div>
      <div class="card-sub">output tokens</div>
    </div>
    <div class="card">
      <div class="card-label">Total Spend</div>
      <div class="card-value green" id="statCost">$${totalCost.toFixed(2)}</div>
      <div class="card-sub">USD</div>
    </div>
  </div>
  <div class="table-section">
    <div class="table-header">
      <div class="table-title">Session Log</div>
      <div class="table-count" id="rowCount">${rowCount} entr${rowCount === 1 ? 'y' : 'ies'}</div>
    </div>
    <div class="table-wrap">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Model</th>
              <th>Start Time</th>
              <th>Duration</th>
              <th>Tokens In</th>
              <th>Tokens Out</th>
              <th>Cost</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody id="tableBody">${rowsHtml}${emptyRow}</tbody>
        </table>
      </div>
    </div>
  </div>
</main>

<script>
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
</html>`;

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
