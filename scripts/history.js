'use strict';
// Session history: one line per finished session in <claude_dir>/statusline/history.js.
// Each line is `h([id,project,model,start,dur,in,cache,out,cost,reason]);` — valid JSON inside
// a JS call, so the dashboard page can load the file directly with <script src>.
// The file is only ever appended to. Readers keep the last line per id, so a resumed session
// (or one finalized early by the stale sweep) is never counted twice. Mirrors src/history.rs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getHomeDir } = require('./config');
const session = require('./session');

// Session state files untouched this long belong to sessions that ended without SessionEnd.
const STALE_SECS = 24 * 60 * 60;

const historyPath = claudeDir => path.join(claudeDir, 'statusline', 'history.js');
const toUtcString = secs => new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 19);

function formatLine(id, project, model, start, dur, tin, tcache, tout, cost, reason) {
  const row = [String(id).slice(0, 8), project, model, start, dur, tin, tcache, tout,
    Math.round(cost * 10000) / 10000, reason];
  return `h(${JSON.stringify(row)});\n`;
}

function parseLine(line) {
  const m = /^h\((.*)\);$/.exec(line.trim());
  if (!m) return null;
  let v;
  try { v = JSON.parse(m[1]); } catch (e) { return null; }
  if (!Array.isArray(v)) return null;
  const s = i => (typeof v[i] === 'string' ? v[i] : '');
  const n = i => (Number.isInteger(v[i]) && v[i] > 0 ? v[i] : 0);
  return {
    id: s(0), project_name: s(1), model: s(2), start: n(3), start_time: toUtcString(n(3)),
    duration_seconds: n(4), tokens_in: n(5), tokens_cache: n(6), tokens_out: n(7),
    cost_usd: typeof v[8] === 'number' ? v[8] : 0, exit_reason: s(9),
  };
}

// All sessions, newest first, keeping only the last line per id.
function readHistory(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {}
  const latest = new Map();
  const anonymous = [];
  for (const rec of text.split('\n').map(parseLine)) {
    if (!rec) continue;
    if (rec.id) latest.set(rec.id, rec); else anonymous.push(rec);
  }
  return [...latest.values(), ...anonymous].sort((a, b) => b.start - a.start);
}

function append(file, text) {
  if (!text) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ponytail: one small O_APPEND write per call is atomic on local filesystems, so no lock.
    fs.appendFileSync(file, text);
  } catch (e) {}
}

// History line for a session state, or '' when the session used no tokens.
function recordLine(id, state, reason, now) {
  if (state.tin + state.tcache + state.tout === 0) return '';
  const start = state.start || now;
  const dur = state.dur > 0 ? state.dur : Math.max(0, now - start);
  return formatLine(id, state.project, state.model || 'Claude', start, dur,
    state.tin, state.tcache, state.tout, state.cost, reason);
}

function removeState(file) {
  for (const f of [file, file.replace(/\.json$/, '.tmp')]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

// Writes the history line for a finished session and deletes its state file.
function finalize(claudeDir, sessionId, transcript, reason, now) {
  const stateFile = session.statePath(claudeDir, sessionId);
  if (!stateFile) return;
  const state = session.load(stateFile);
  // Catch up on the last turn, which may not have been rendered.
  if (transcript) session.updateTokens(state, transcript);
  append(historyPath(claudeDir), recordLine(sessionId, state, reason, now));
  removeState(stateFile);
}

// Finalizes state files of sessions that ended without a SessionEnd hook (crash, kill).
function sweepStale(claudeDir, now) {
  const dir = path.join(claudeDir, 'statusline', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  let lines = '';
  for (const name of names) {
    const file = path.join(dir, name);
    let age = 0;
    try { age = (Date.now() - fs.statSync(file).mtimeMs) / 1000; } catch (e) {}
    if (age < STALE_SECS) continue;
    if (name.endsWith('.json')) lines += recordLine(name.slice(0, -5), session.load(file), 'other', now);
    removeState(file);
  }
  append(historyPath(claudeDir), lines);
}

// One-time move from the pre-1.7 layout: converts statusline-history.jsonl (always under
// ~/.claude) and deletes the loose per-session and realtime files.
function migrateLegacy(claudeDir, homeClaudeDir) {
  const legacy = path.join(homeClaudeDir, 'statusline-history.jsonl');
  let text = null;
  try { text = fs.readFileSync(legacy, 'utf8'); } catch (e) {}
  if (text !== null) {
    let lines = '';
    for (const raw of text.split('\n')) {
      let v;
      try { v = JSON.parse(raw); } catch (e) { continue; }
      if (!v || !v.exit_reason || v.exit_reason === 'pending') continue;
      const start = Math.floor(Date.parse(`${String(v.start_time).replace(' ', 'T')}Z`) / 1000) || 0;
      // No id: the old hook guessed session ids and often gave several sessions the same
      // one, so deduplicating would merge distinct rows.
      lines += formatLine('', v.project_name || '', v.model || 'Claude', start,
        v.duration_seconds || 0, v.tokens_in || 0, 0, v.tokens_out || 0, v.cost_usd || 0, v.exit_reason);
    }
    // Prepend so migrated rows sit before anything already written in the new format.
    const file = historyPath(claudeDir);
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch (e) {}
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, lines + existing);
      fs.renameSync(`${file}.tmp`, file);
      fs.unlinkSync(legacy);
    } catch (e) {}
  }
  const prefixes = ['statusline-tokcache-', 'statusline-session-', 'statusline-state-', 'statusline-renderer-', 'statusline-rt-'];
  for (const dir of new Set([claudeDir, homeClaudeDir])) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of names) {
      if (prefixes.some(p => name.startsWith(p))) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
      }
    }
  }
  try { fs.unlinkSync(path.join(os.tmpdir(), 'claude-statusline-dashboard.html')); } catch (e) {}
}

// SessionEnd hook: stdin carries session_id, transcript_path and reason.
function handleHookEnd() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    let v = {};
    try { v = JSON.parse(input) || {}; } catch (e) {}
    try {
      const claudeDir = session.claudeDir();
      const now = session.nowSecs();
      migrateLegacy(claudeDir, path.join(getHomeDir(), '.claude'));
      finalize(claudeDir, v.session_id || '', v.transcript_path || '', v.reason || 'other', now);
      sweepStale(claudeDir, now);
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
  const sessions = readHistory(historyPath(session.claudeDir())).slice(0, 100);
  const sessionsJson = JSON.stringify(sessions);

  // Inject CSS, JS, and data into the template using the sentinel strings
  const html = template
    .replace('/*INJECT_CSS*/', css)
    .replace('/*INJECT_DATA*/null', sessionsJson)
    .replace('/*INJECT_JS*/', js);

  const tempPath = path.join(os.tmpdir(), 'claude-statusline-dashboard.html');
  fs.writeFileSync(tempPath, html);
  try {
    const open = require('open');
    await open.default(tempPath);
    console.log(`Dashboard opened: ${tempPath}`);
  } catch (e) {
    console.log(`Dashboard saved: ${tempPath}`);
  }
}

module.exports = {
  historyPath, formatLine, parseLine, readHistory, recordLine,
  finalize, sweepStale, migrateLegacy, handleHookEnd, handleHistory,
};
