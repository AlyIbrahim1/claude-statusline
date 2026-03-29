#!/usr/bin/env node
'use strict';
const { setup, toggleHistory } = require('../scripts/setup');
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
  enable-history   Enable tracking session analytics to SQLite (default on setup)
  disable-history  Remove history tracking hooks from Claude settings
  history          Open the session analytics dashboard
`.trim();

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

} else if (cmd === 'hook' || cmd === 'history') {
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

} else if (cmd === undefined) {
  console.log(USAGE);
  process.exit(0);

} else {
  console.error(`Unknown command: ${cmd}`);
  console.log('\n' + USAGE);
  process.exit(1);
}
