#!/usr/bin/env node
// Claude Code Statusline
// Shows: model | directory | context usage, then usage/cost/tokens

const fs = require('fs');
const path = require('path');
const { getHomeDir } = require('./scripts/config');
const sessionState = require('./scripts/session');

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
    return; // No-op: kept so SessionStart hooks written by older versions still exit 0.
  } else if (hookcmd === 'end') {
    require('./scripts/history').handleHookEnd();
    return;
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

    const homeDir = getHomeDir();
    let absDir = path.resolve(dir);
    try { absDir = fs.realpathSync(absDir); } catch (e) {}

    // Per-session state: transcript cursors, token totals, git baselines
    const stateFile = sessionState.statePath(sessionState.claudeDir(), session);
    const state = sessionState.load(stateFile); // empty state when there is no session id
    const loaded = JSON.stringify(state);
    if (stateFile) {
      if (!state.start) sessionState.pruneAbandoned(path.dirname(stateFile)); // first render of this session
      sessionState.noteInput(state, data, model, dir);
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
    const { branch, commits: commitCount } = sessionState.gitInfo(absDir, state);

    // Session tokens from the transcript (and subagent transcripts), deduplicated
    if (data.transcript_path) sessionState.updateTokens(state, data.transcript_path);
    if (stateFile && JSON.stringify(state) !== loaded) sessionState.save(stateFile, state);

    // Output
    const safeBranch = sanitize(branch);
    let dirLabel;
    if (absDir === homeDir) {
      dirLabel = '~';
    } else if (path.dirname(absDir) === homeDir) {
      dirLabel = `~/${path.basename(absDir)}`;
    } else {
      const prefix = absDir.startsWith(homeDir + path.sep) ? '~/' : '';
      dirLabel = `${prefix}${path.basename(path.dirname(absDir))}/${path.basename(absDir)}`;
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
    // Session tokens: `12.3k↓ + 1.2M cache 8.1k↑` (cache part dimmed, omitted when zero)
    let tokenDisplay = '';
    if (Object.keys(state.files).length) {
      const fmt = n => n >= 1_000_000 ? (n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`)
                     : n >= 1000     ? `${(n / 1000).toFixed(1)}k`
                     : String(n);
      const cache = state.tcache > 0 ? ` \x1b[2m+ ${fmt(state.tcache)} cache\x1b[0m\x1b[97m` : '';
      tokenDisplay = `\x1b[97m${fmt(state.tin)}↓${cache} ${fmt(state.tout)}↑\x1b[0m`;
    }

    const usageContent = [u7d, u5h].filter(Boolean).join('  ');
    const line2Chunks = ['\x1b[0m\x1b[32mUsage\x1b[0m'];
    if (usageContent) line2Chunks.push(usageContent);
    if (costDisplay) line2Chunks.push(costDisplay.trimStart());
    if (tokenDisplay) line2Chunks.push(tokenDisplay);
    // Effort level: live value from stdin (absent when the model has no effort parameter)
    const effortTags = {
      low: ['\x1b[32m', 'L'], medium: ['\x1b[33m', 'M'], high: ['\x1b[38;5;208m', 'H'],
      xhigh: ['\x1b[38;5;202m', 'XH'], max: ['\x1b[31m', 'MAXX'],
    };
    const effort = effortTags[data.effort?.level];
    const effortSuffix = effort ? ` \x1b[0m${effort[0]}[${effort[1]}]\x1b[0m` : '';

    const modelDisplay = `\x1b[0m\x1b[94m${model}\x1b[0m` + effortSuffix;
    const line1Chunks = [modelDisplay];
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
