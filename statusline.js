#!/usr/bin/env node
// Claude Code Statusline
// Shows: model | current task | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

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
    // Session token consumption (cumulative input + output across all turns)
    const totalIn  = data.context_window?.total_input_tokens  ?? null;
    const totalOut = data.context_window?.total_output_tokens ?? null;
    let tokenDisplay = '';
    if (totalIn != null || totalOut != null) {
      const total = (totalIn ?? 0) + (totalOut ?? 0);
      const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      tokenDisplay = `\x1b[2m│\x1b[0m \x1b[97m${fmt(total)} tok\x1b[0m`;
    }

    const usageContent = [u7d, u5h].filter(Boolean).join('  ');
    const line2 = (usageContent || costDisplay || tokenDisplay)
      ? `\x1b[0m\x1b[32mUsage\x1b[0m \x1b[2m│\x1b[0m ${[usageContent, costDisplay, tokenDisplay].filter(Boolean).join('  ')}`
      : '';
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
    const line1 = task
      ? `${modelDisplay} \x1b[2m│\x1b[0m \x1b[1m${task}\x1b[0m \x1b[2m│\x1b[0m ${dirDisplay}${ctx}`
      : `${modelDisplay} \x1b[2m│\x1b[0m ${dirDisplay}${ctx}`;
    const visibleLen = line1.replace(/\x1b\[[0-9;]*m/g, '').length;
    const sep = `\x1b[2m${'─'.repeat(visibleLen)}\x1b[0m`;
    process.stdout.write(line2 ? `${line1}\n${sep}\n${line2}` : line1);
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
