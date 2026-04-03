#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { setup } = require('./setup');
const config = require('./config');
try {
  const result = setup({ force: false });
  if (result.settingsPath === null) process.exit(0); // non-global install, skip silently

  const sourceDir = path.join(__dirname, '..', '.claude', 'commands');
  const commandsDir = path.join(path.dirname(result.settingsPath), 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  for (const f of fs.readdirSync(sourceDir)) {
    fs.copyFileSync(path.join(sourceDir, f), path.join(commandsDir, f));
  }

  if (!result.ok) {
    console.warn('\n⚠  claude-statusline: auto-setup failed:', result.error);
    console.warn('   Run manually: claude-statusline setup\n');
  } else {
    console.log('\n✓  claude-statusline configured. Restart Claude Code to see it.\n');
  }
  const binaryPath = config.resolveBinary();
  if (binaryPath && process.platform !== 'win32') {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch (e) {}
  }
} catch (e) {
  // Fully silent on any error — postinstall must never fail npm install
}
process.exit(0); // always exit 0 — never fail npm install
