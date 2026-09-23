'use strict';
// Per-session state kept in <claude_dir>/statusline/sessions/<session_id>.json:
// transcript read cursors, deduplicated token totals, git commit baselines, and the
// last values seen for the history record written at SessionEnd.
// Same file format as src/session.rs.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getClaudeConfigDir } = require('./config');

function statePath(claudeDir, session) {
  if (!session || !/^[A-Za-z0-9_-]+$/.test(session)) return null;
  return path.join(claudeDir, 'statusline', 'sessions', `${session}.json`);
}

function emptyState() {
  return { files: {}, tin: 0, tcache: 0, tout: 0, git: {}, start: 0, model: '', project: '', cost: 0, dur: 0 };
}

const nowSecs = () => Math.floor(Date.now() / 1000);

// Records the values the history needs from one statusline input.
function noteInput(state, data, model, dir) {
  if (!state.start) state.start = nowSecs();
  state.model = model;
  const projectDir = data.workspace?.project_dir || dir;
  state.project = path.basename(projectDir).replace(/\x1b\[[0-9;]*[mGKHFABCDJ]/g, '');
  if (typeof data.cost?.total_cost_usd === 'number') state.cost = data.cost.total_cost_usd;
  if (Number.isInteger(data.cost?.total_duration_ms)) state.dur = Math.floor(data.cost.total_duration_ms / 1000);
}

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) return { ...emptyState(), ...s };
  } catch (e) {}
  return emptyState();
}

function save(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file.replace(/\.json$/, '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch (e) {}
}

function countLine(line, cursor, state) {
  // Cheap pre-filter: most lines are large tool results that never carry usage.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch (e) { return; }
  const usage = entry && entry.type === 'assistant' && entry.message && entry.message.usage;
  if (!usage || typeof usage !== 'object') return;
  // Claude Code writes one line per content block, each repeating the same usage; repeats are adjacent.
  const id = entry.message.id || '';
  if (id) {
    const key = `${id}:${entry.requestId || ''}`;
    if (key === cursor.key) return;
    cursor.key = key;
  }
  const n = k => (Number.isInteger(usage[k]) && usage[k] > 0 ? usage[k] : 0);
  state.tin += n('input_tokens') + n('cache_creation_input_tokens');
  state.tcache += n('cache_read_input_tokens');
  state.tout += n('output_tokens');
}

function scanFile(file, cursor, state) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return false; }
  try {
    const len = fs.fstatSync(fd).size;
    if (len < cursor.off) cursor.off = len; // ponytail: append-only; a shrink means replacement, skip
    if (len === cursor.off) return true;
    const buf = Buffer.alloc(len - cursor.off);
    const read = fs.readSync(fd, buf, 0, buf.length, cursor.off);
    const lastNl = buf.subarray(0, read).lastIndexOf(0x0a);
    if (lastNl === -1) return true; // only a partial line so far
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) countLine(line, cursor, state);
    cursor.off += lastNl + 1;
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// Reads new bytes of the main transcript and of <transcript stem>/subagents/*.jsonl.
function updateTokens(state, transcript) {
  const files = [transcript];
  try {
    const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
    files.push(...fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().map(f => path.join(dir, f)));
  } catch (e) {}
  for (const file of files) {
    const cursor = { off: 0, key: '', ...(state.files[file] || {}) };
    if (scanFile(file, cursor, state)) state.files[file] = cursor;
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return null; }
}

// Walks up from start to the repo root. Returns { root, gitdir, common } or null.
function findGit(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (e) {}
    if (st && st.isDirectory()) return { root: dir, gitdir: dotgit, common: dotgit };
    if (st && st.isFile()) {
      // Linked worktree or submodule: ".git" is a file containing "gitdir: <path>".
      const m = /^gitdir:\s*(.+)$/.exec(readText(dotgit) || '');
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1].trim());
      const commondir = readText(path.join(gitdir, 'commondir'));
      return { root: dir, gitdir, common: commondir ? path.resolve(gitdir, commondir) : gitdir };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

// { branch, sha } straight from the files in .git, or null when git itself is needed.
function readHead(gitdir, common) {
  const head = readText(path.join(gitdir, 'HEAD'));
  if (head === null) return null;
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    const branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
    if (branch === '.invalid') return null; // reftable backend
    let sha = readText(path.join(common, ref));
    if (sha === null) {
      const packed = readText(path.join(common, 'packed-refs')) || '';
      const hit = packed.split('\n').map(l => l.split(' ')).find(p => p[1] === ref);
      sha = hit ? hit[0] : ''; // unborn branch: no commits yet
    }
    return { branch, sha };
  }
  return /^[0-9a-f]{40,}$/i.test(head) ? { branch: head.slice(0, 7), sha: head } : null;
}

function gitOutput(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) {
    return null;
  }
}

// Returns { branch, commits }. Reads .git directly; spawns git only for unusual layouts
// and when HEAD moved since the last render.
function gitInfo(dir, state) {
  const repo = findGit(dir);
  if (!repo) return { branch: '', commits: 0 };
  let head = readHead(repo.gitdir, repo.common);
  if (!head) {
    const out = gitOutput(repo.root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
    if (out === null) return { branch: '', commits: 0 };
    const [sha = '', branch = ''] = out.split('\n').map(s => s.trim());
    head = { sha, branch: branch === 'HEAD' ? sha.slice(0, 7) : branch };
  }
  if (!head.sha) return { branch: head.branch, commits: 0 };
  const cur = state.git[repo.root] || (state.git[repo.root] = { base: '', sha: '', n: 0 });
  if (!cur.base) {
    Object.assign(cur, { base: head.sha, sha: head.sha, n: 0 });
  } else if (cur.sha !== head.sha) {
    const out = gitOutput(repo.root, ['rev-list', '--count', `${cur.base}..${head.sha}`]);
    cur.n = parseInt(out, 10) || 0;
    cur.sha = head.sha;
  }
  return { branch: head.branch, commits: cur.n };
}

module.exports = { claudeDir: getClaudeConfigDir, statePath, load, save, updateTokens, gitInfo, noteInput, nowSecs };
