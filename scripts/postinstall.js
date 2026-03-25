#!/usr/bin/env node
'use strict';
const { setup } = require('./setup');
try {
  const result = setup({ force: false });
  if (result.settingsPath === null) process.exit(0); // non-global install, skip silently
  if (!result.ok) {
    console.warn('\n⚠  claude-statusline: auto-setup failed:', result.error);
    console.warn('   Run manually: claude-statusline setup\n');
  } else {
    console.log('\n✓  claude-statusline configured. Restart Claude Code to see it.\n');
  }
} catch (e) {
  // Fully silent on any error — postinstall must never fail npm install
}
process.exit(0); // always exit 0 — never fail npm install
