#!/usr/bin/env node
// Claude Code Statusline
// Shows: model | current task | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { normalizeProjectSlug } = require('./scripts/slug-utils');

function realtimeEnabled() {
  const v = process.env.CLAUDE_STATUSLINE_REALTIME;
  return v === '1' || v === 'true' || v === 'TRUE';
}

function realtimeTtySlug() {
  const raw = (process.env.CLAUDE_STATUSLINE_TTY || process.env.TERM_SESSION_ID || `pid-${process.pid}`).trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function atomicWrite(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath);
}

function emitRealtimeEvent(eventType, payload) {
  if (!realtimeEnabled()) return;
  try {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const ttySlug = realtimeTtySlug();
    const now = Date.now();
    const statePath = path.join(claudeDir, `statusline-state-${ttySlug}.json`);
    const registryPath = path.join(claudeDir, `statusline-renderer-${ttySlug}.json`);

    atomicWrite(registryPath, {
      version: 1,
      pid: process.pid,
      tty_slug: ttySlug,
      heartbeat_at_ms: now,
      socket_path: path.join(claudeDir, `statusline-rt-${ttySlug}.sock`),
    });

    atomicWrite(statePath, {
      version: 1,
      event_type: eventType,
      tty_slug: ttySlug,
      updated_at_ms: now,
      payload: payload || {},
    });
  } catch (_) {
    // Silent fail - never break statusline rendering
  }
}

function stripSgr(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLen(s) {
  return [...stripSgr(String(s))].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0xFFFF ? 2 : 1), 0);
}

function terminalColumns() {
  const fromStdout = Number(process.stdout && process.stdout.columns);
  if (Number.isFinite(fromStdout) && fromStdout > 0) return fromStdout;
  const fromEnv = Number(process.env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return null;
}

function truncateVisible(s, maxVisible) {
  if (!maxVisible || maxVisible <= 0) return '';
  if (visibleLen(s) <= maxVisible) return String(s);

  const src = String(s);
  let out = '';
  let visible = 0;
  for (let i = 0; i < src.length;) {
    if (src[i] === '\x1b' && src[i + 1] === '[') {
      let j = i + 2;
      while (j < src.length && /[0-9;]/.test(src[j])) j++;
      if (j < src.length && /[mGKHFABCDJ]/.test(src[j])) {
        out += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }

    const code = src.codePointAt(i);
    const ch = String.fromCodePoint(code);
    const width = code > 0xFFFF ? 2 : 1;
    if (visible + width > maxVisible) break;
    out += ch;
    visible += width;
    i += code > 0xFFFF ? 2 : 1;
  }
  return `${out}…\x1b[0m`;
}

function wrapChunks(chunks, width, sep) {
  if (!width) return [chunks.join(sep)];
  if (width < 8) {
    return chunks.map(c => truncateVisible(c, Math.max(1, width - 1)));
  }

  const sepLen = visibleLen(sep);
  const lines = [];
  let current = '';
  let currentLen = 0;

  for (const rawChunk of chunks) {
    const chunk = visibleLen(rawChunk) > width
      ? truncateVisible(rawChunk, Math.max(1, width - 1))
      : rawChunk;
    const chunkLen = visibleLen(chunk);

    if (!current) {
      current = chunk;
      currentLen = chunkLen;
      continue;
    }

    const needed = currentLen + sepLen + chunkLen;
    if (needed <= width) {
      current += `${sep}${chunk}`;
      currentLen = needed;
    } else {
      lines.push(current);
      current = chunk;
      currentLen = chunkLen;
    }
  }

  if (current) lines.push(current);
  return lines;
}

const cmd = process.argv[2];
if (cmd === 'history') {
  require('./scripts/history').handleHistory().catch(e => {
    console.error('history error:', e.message);
    process.exit(1);
  });
  return;
} else if (cmd === 'hook') {
  const hookcmd = process.argv[3];
  if (hookcmd === 'start') {
    emitRealtimeEvent('session_start', {});
    require('./scripts/history').handleHookStart();
    return;
  } else if (hookcmd === 'end') {
    emitRealtimeEvent('session_end', {});
    require('./scripts/history').handleHookEnd();
    return;
  }
} else if (cmd === 'realtime') {
  const subcmd = process.argv[3];
  if (subcmd === 'shutdown') {
    emitRealtimeEvent('shutdown', {});
    return;
  }
}

// Reads cumulative token totals from the session JSONL file, using a byte-offset
// cache so only new bytes are parsed on each invocation (O(new bytes) not O(file)).
// Returns { totalIn, totalOut } or null on any error.
function readSessionTokens(claudeDir, session, absDir) {
  if (!session) return null;
  const slug = normalizeProjectSlug(absDir);
  const jsonlPath = path.join(claudeDir, 'projects', slug, `${session}.jsonl`);
  const cachePath = path.join(claudeDir, `statusline-tokcache-${session}.json`);
  try {
    const fileSize = fs.statSync(jsonlPath).size;
    let totalIn = 0, totalOut = 0, cachedOffset = 0;
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      totalIn = cached.totalIn || 0;
      totalOut = cached.totalOut || 0;
      cachedOffset = Math.min(cached.offset || 0, fileSize);
    } catch (e) {}
    if (fileSize > cachedOffset) {
      const fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(fileSize - cachedOffset);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, cachedOffset);
      fs.closeSync(fd);
      const content = buf.subarray(0, bytesRead).toString('utf8');
      // Exclude the last element: it's either an empty string (content ends with \n)
      // or a potentially incomplete line (file was mid-write).
      const safeLines = content.split('\n').slice(0, -1);
      for (const line of safeLines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) {
            const u = entry.message.usage;
            totalIn  += (u.input_tokens || 0) + Math.round((u.cache_read_input_tokens || 0) * 0.1) + (u.cache_creation_input_tokens || 0);
            totalOut += (u.output_tokens || 0);
          }
        } catch (e) {}
      }
      // Advance offset by the bytes of all complete lines (each terminated by \n)
      const processed = safeLines.join('\n') + '\n';
      try {
        fs.writeFileSync(cachePath, JSON.stringify({
          totalIn, totalOut, offset: cachedOffset + Buffer.from(processed, 'utf8').length,
        }));
      } catch (e) {}
    }
    return { totalIn, totalOut };
  } catch (e) {
    return null;
  }
}

// Read JSON from stdin
let input = '';
// Timeout guard: if stdin doesn't close within 3s (e.g. pipe issues on
// Windows/Git Bash), exit silently instead of hanging.
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const sanitize = s => String(s).replace(/\x1b\[[0-9;]*[mGKHFABCDJ]/g, '');
    const data = JSON.parse(input);
    emitRealtimeEvent('state_update', data);
    const model = sanitize(data.model?.display_name || 'Claude');
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display (shows USED percentage scaled to usable context)
    // Claude Code reserves ~16.5% for autocompact buffer, so usable context
    // is 83.5% of the total window. We normalize to show 100% at that point.
    const AUTO_COMPACT_BUFFER_PCT = 16.5;
    let ctx = '';
    if (remaining != null) {
      // Normalize: subtract buffer from remaining, scale to usable range
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      // Color based on usable context thresholds
      if (used < 50) {
        ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m`;
      }
    }

    // Current task from todos
    let task = '';
    let activeAgents = 0;
    const homeDir = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        for (const f of files) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, f.name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) {
              activeAgents++;
              if (!task) task = sanitize(inProgress.activeForm || '');
            }
          } catch (e) {}
        }
      } catch (e) {
        // Silently fail on file system errors - don't break statusline
      }
    }

    // Session cost — only show for API key users; rate_limits presence means subscription
    const isSubscription = data.rate_limits !== undefined;
    const sessionCost = !isSubscription ? (data.cost?.total_cost_usd ?? null) : null;

    // Usage limits — provided by Claude Code in stdin; no API call needed
    const pct5h      = data.rate_limits?.five_hour?.used_percentage ?? null;
    const pctWeek    = data.rate_limits?.seven_day?.used_percentage ?? null;
    const resetsAt5h = data.rate_limits?.five_hour?.resets_at ?? null; // Unix epoch seconds

    function usageLine(label, pct, suffix = '') {
      if (pct === null) return '';
      const p = Math.round(pct);
      const color = p < 50 ? '\x1b[32m' : p < 75 ? '\x1b[33m' : '\x1b[31m';
      return `\x1b[0m\x1b[97m${label}:\x1b[0m ${color}${p}%\x1b[0m${suffix}`;
    }

    let resetSuffix = '';
    if (resetsAt5h) {
      const resetDate = new Date(resetsAt5h * 1000); // stdin gives epoch seconds
      if (!isNaN(resetDate)) {
        const minsLeft = Math.max(0, Math.round((resetDate - Date.now()) / 60_000));
        const h = Math.floor(minsLeft / 60), m = minsLeft % 60;
        resetSuffix = ` \x1b[2m↺ ${h}h${String(m).padStart(2, '0')}m\x1b[0m`;
      }
    }

    // Git branch + session commit counter
    const absDir = path.resolve(dir);
    let branch = '';
    let commitCount = 0;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const headSha = execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (session) {
        const sessionFile = path.join(claudeDir, `statusline-session-${session}.json`);
        let sessionData = {};
        try { sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch (e) {}
        if (!sessionData[absDir]) {
          sessionData[absDir] = headSha;
          try { fs.writeFileSync(sessionFile, JSON.stringify(sessionData)); } catch (e) {}
        }
        const baseline = sessionData[absDir];
        if (baseline !== headSha) {
          const countStr = execFileSync('git', ['rev-list', '--count', `${baseline}..HEAD`], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          commitCount = parseInt(countStr, 10) || 0;
        }
      }
    } catch (e) {}

    // Output
    const safeBranch = sanitize(branch);
    let dirLabel;
    if (absDir === homeDir) {
      dirLabel = '~';
    } else if (path.dirname(absDir) === homeDir) {
      dirLabel = `~/${path.basename(absDir)}`;
    } else {
      dirLabel = `~/${path.basename(path.dirname(absDir))}/${path.basename(absDir)}`;
    }
    const dirname = sanitize(dirLabel);
    // dirname is bright; branch stays cyan; commit count dim after branch
    const commitSuffix = commitCount > 0 ? ` \x1b[32m+${commitCount}` : '';
    const branchStr = `(${safeBranch})${commitSuffix}\x1b[0m \x1b[2m│\x1b[0m`;
    const dirDisplay = safeBranch
      ? `\x1b[1m\x1b[97m${dirname}\x1b[0m\x1b[2m \x1b[36m${branchStr}\x1b[0m`
      : `\x1b[1m\x1b[97m${dirname}\x1b[0m`;
    const u5h = usageLine('Current', pct5h, resetSuffix), u7d = usageLine('Weekly', pctWeek);
    const costDisplay = sessionCost !== null
      ? `  \x1b[33m$${sessionCost < 0.01 ? sessionCost.toFixed(4) : sessionCost.toFixed(2)}\x1b[0m`
      : '';
    // Session token consumption — prefer JSONL-sourced totals (accurate through
    // the last completed tool use) over the stdin snapshot (only updated at turn start).
    const stdinIn   = data.context_window?.total_input_tokens  ?? null;
    const stdinOut  = data.context_window?.total_output_tokens ?? null;
    const jsonlTok  = readSessionTokens(claudeDir, session, absDir);
    const totalIn   = jsonlTok && jsonlTok.totalIn  > (stdinIn  ?? 0) ? jsonlTok.totalIn  : stdinIn;
    const totalOut  = jsonlTok && jsonlTok.totalOut > (stdinOut ?? 0) ? jsonlTok.totalOut : stdinOut;
    let tokenDisplay = '';
    if (totalIn != null || totalOut != null || jsonlTok) {
      const fmt = n => n >= 1_000_000 ? (n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`)
                     : n >= 1000     ? `${(n / 1000).toFixed(1)}k`
                     : String(n);
      tokenDisplay = `\x1b[97m${fmt(totalIn ?? 0)}↓ ${fmt(totalOut ?? 0)}↑\x1b[0m`;
    }

    const usageContent = [u7d, u5h].filter(Boolean).join('  ');
    const line2Chunks = ['\x1b[0m\x1b[32mUsage\x1b[0m'];
    if (usageContent) line2Chunks.push(usageContent);
    if (costDisplay) line2Chunks.push(costDisplay.trimStart());
    if (tokenDisplay) line2Chunks.push(tokenDisplay);
    // Effort level: read from env var first, then settings.json, then fall back to
    // model-based default (sonnet-4/opus-4 default to "medium" in Claude Code).
    const effortLetters = { low: 'L', medium: 'M', high: 'H' };
    let effortSuffix = '';
    try {
      let rawEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL
        || JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'))?.effortLevel
        || '';
      if (!rawEffort) {
        const m = model.toLowerCase();
        if (m.includes('sonnet-4') || m.includes('opus-4')) rawEffort = 'medium';
      }
      const effortColors = { low: '\x1b[32m', medium: '\x1b[33m', high: '\x1b[38;5;208m', max: '\x1b[31m' };
      const level = rawEffort?.toLowerCase();
      const color = effortColors[level] || '';
      if (level === 'max') {
        effortSuffix = ` \x1b[0m${color}[MAXX]\x1b[0m`;
      } else {
        const letter = effortLetters[level];
        if (letter) effortSuffix = ` \x1b[0m${color}[${letter}]\x1b[0m`;
      }
    } catch (e) {}

    const agentDisplay = activeAgents > 0 ? ` \x1b[0m\x1b[36m↪ ${activeAgents}\x1b[0m` : '';
    const modelDisplay = `\x1b[0m\x1b[94m${model}\x1b[0m` + effortSuffix + agentDisplay;
    const line1Chunks = [modelDisplay];
    if (task) line1Chunks.push(`\x1b[1m${task}\x1b[0m`);
    line1Chunks.push(`${dirDisplay}${ctx}`);

    const columns = terminalColumns();
    const sepToken = ' \x1b[2m│\x1b[0m ';
    const wrappedLine1 = wrapChunks(line1Chunks, columns, sepToken);
    const sepLen = wrappedLine1.reduce((max, line) => Math.max(max, visibleLen(line)), 0);
    const sep = `\x1b[2m${'─'.repeat(sepLen)}\x1b[0m`;
    const wrappedLine2 = line2Chunks.length > 1 ? wrapChunks(line2Chunks, columns, sepToken) : [];
    process.stdout.write(wrappedLine2.length ? `${wrappedLine1.join('\n')}\n${sep}\n${wrappedLine2.join('\n')}` : wrappedLine1.join('\n'));
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
