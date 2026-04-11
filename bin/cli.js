#!/usr/bin/env node
'use strict';
const { setup, toggleHistory, getDashboardMode, setDashboardMode } = require('../scripts/setup');
const { uninstall } = require('../scripts/uninstall');
const config = require('../scripts/config');
const { getSettingsPath } = config;
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const USAGE = `
claude-statusline <command>

Commands:
  setup            Configure ~/.claude/settings.json to use this statusline
  uninstall        Remove this statusline from ~/.claude/settings.json
  download-binary  Download the native binary for this platform
  enable-history   Enable tracking session analytics to JSONL (default on setup)
  disable-history  Remove history tracking hooks from Claude settings
  realtime-status  Show realtime renderer state for current terminal
  realtime-stop    Request realtime renderer shutdown for current terminal
  history          Open the session analytics dashboard
                   --mode web|terminal (persist dashboard mode preference)
`.trim();

const TERMINAL_FALLBACK_WARNING = [
  '[claude-statusline] terminal mode requires the native binary.',
  'Falling back to web dashboard. To install the binary, run:',
  '  claude-statusline download-binary'
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

function runRealtimeStatus() {
  const paths = config.getRealtimePaths();
  let registry = null;
  let state = null;

  try {
    if (fs.existsSync(paths.registryPath)) {
      registry = JSON.parse(fs.readFileSync(paths.registryPath, 'utf8'));
    }
  } catch (e) {}

  try {
    if (fs.existsSync(paths.statePath)) {
      state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    }
  } catch (e) {}

  const summary = {
    ttySlug: paths.ttySlug,
    registryPath: paths.registryPath,
    statePath: paths.statePath,
    socketPath: paths.socketPath,
    hasRegistry: !!registry,
    hasState: !!state,
    registry,
    stateEventType: state?.event_type || null,
    stateUpdatedAt: state?.updated_at_ms || null,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

function runRealtimeStop() {
  const net = require('net');
  const paths = config.getRealtimePaths();
  const ts = Date.now();
  const event = {
    version: 1,
    event_type: 'shutdown',
    tty_slug: paths.ttySlug,
    updated_at_ms: ts,
  };

  try {
    config.atomicWrite(paths.statePath, event);
  } catch (e) {}

  const done = () => {
    console.log('✓ Realtime shutdown event sent');
    process.exit(0);
  };

  if (fs.existsSync(paths.socketPath)) {
    const client = net.createConnection(paths.socketPath);
    client.on('connect', () => {
      client.write(JSON.stringify(event) + '\n');
      client.end();
    });
    client.on('close', done);
    client.on('error', done);
  } else {
    done();
  }
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

} else if (cmd === 'realtime-status') {
  runRealtimeStatus();

} else if (cmd === 'realtime-stop') {
  runRealtimeStop();

} else if (cmd === undefined) {
  console.log(USAGE);
  process.exit(0);

} else {
  console.error(`Unknown command: ${cmd}`);
  console.log('\n' + USAGE);
  process.exit(1);
}
