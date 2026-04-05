#!/usr/bin/env node
'use strict';
const { setup, toggleHistory, getDashboardMode, setDashboardMode } = require('../scripts/setup');
const { uninstall } = require('../scripts/uninstall');
const config = require('../scripts/config');
const { getSettingsPath } = config;
const { spawnSync } = require('child_process');
const path = require('path');

const USAGE = `
claude-statusline <command>

Commands:
  setup            Configure ~/.claude/settings.json to use this statusline
  uninstall        Remove this statusline from ~/.claude/settings.json
  download-binary  Download the native binary for this platform
  enable-history   Enable tracking session analytics to JSONL (default on setup)
  disable-history  Remove history tracking hooks from Claude settings
  history          Open the session analytics dashboard
                   --mode web|terminal (persist dashboard mode preference)
`.trim();

const TERMINAL_FALLBACK_WARNING = [
  '[claude-statusline] terminal mode requires the native binary.',
  'Falling back to web dashboard. To install the binary, run:',
  '  npm install -g @alyibrahim/claude-statusline'
].join('\n');

function parseHistoryMode(args) {
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode') {
      const value = args[i + 1];
      if (!value) {
        return { ok: false, error: 'Missing value for --mode. Expected "web" or "terminal".' };
      }
      mode = value;
      i++;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
      continue;
    }
    return { ok: false, error: `Unknown history option: ${arg}` };
  }

  if (mode !== undefined && mode !== 'web' && mode !== 'terminal') {
    return { ok: false, error: `Invalid mode: ${mode}. Expected "web" or "terminal".` };
  }

  return { ok: true, mode };
}

function runHistory() {
  const parseResult = parseHistoryMode(process.argv.slice(3));
  if (!parseResult.ok) {
    console.error('Error:', parseResult.error);
    process.exit(1);
  }

  let mode;
  if (parseResult.mode) {
    const saved = setDashboardMode(parseResult.mode);
    if (!saved.ok) {
      console.error('Error:', saved.error);
      process.exit(1);
    }
    mode = parseResult.mode;
  } else {
    const saved = getDashboardMode();
    if (!saved.ok) {
      console.error('Error:', saved.error);
      process.exit(1);
    }
    mode = saved.mode;
  }

  const binaryPath = config.resolveBinary();
  const scriptPath = path.resolve(__dirname, '../statusline.js');

  if (mode === 'terminal') {
    if (binaryPath) {
      const child = spawnSync(binaryPath, ['history', '--terminal'], { stdio: 'inherit' });
      process.exit(child.status || 0);
    }

    console.error(TERMINAL_FALLBACK_WARNING);
    const child = spawnSync(process.execPath, [scriptPath, 'history'], { stdio: 'inherit' });
    process.exit(child.status || 0);
  }

  if (binaryPath) {
    const child = spawnSync(binaryPath, ['history'], { stdio: 'inherit' });
    process.exit(child.status || 0);
  }

  const child = spawnSync(process.execPath, [scriptPath, 'history'], { stdio: 'inherit' });
  process.exit(child.status || 0);
}

const cmd = process.argv[2];

if (cmd === 'setup') {
  const result = setup({ force: true });
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`✓ Configured at ${result.settingsPath}. Restart Claude Code to see it.`);

} else if (cmd === 'uninstall') {
  const result = uninstall();
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`✓ Removed statusline from ${getSettingsPath()}`);

} else if (cmd === 'download-binary') {
  const { downloadBinary } = require('../scripts/download-binary');
  const result = downloadBinary();
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`\n✓ Binary installed at ${result.binaryPath}`);
  console.log('  Run claude-statusline setup to update your settings to use it.\n');

} else if (cmd === 'enable-history') {
  const result = toggleHistory(true);
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`✓ History tracking enabled in ${result.settingsPath}`);

} else if (cmd === 'disable-history') {
  const result = toggleHistory(false);
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`✓ History tracking disabled from ${result.settingsPath}`);

} else if (cmd === 'hook') {
  const binaryPath = config.resolveBinary();
  const scriptPath = path.resolve(__dirname, '../statusline.js');
  
  if (binaryPath) {
    // Run Rust binary
    const child = spawnSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
    process.exit(child.status || 0);
  } else {
    // Run JS fallback
    const child = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(child.status || 0);
  }

} else if (cmd === 'history') {
  runHistory();

} else if (cmd === undefined) {
  console.log(USAGE);
  process.exit(0);

} else {
  console.error(`Unknown command: ${cmd}`);
  console.log('\n' + USAGE);
  process.exit(1);
}
