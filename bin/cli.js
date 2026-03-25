#!/usr/bin/env node
'use strict';
const { setup } = require('../scripts/setup');
const { uninstall } = require('../scripts/uninstall');
const { getSettingsPath } = require('../scripts/config');

const USAGE = `
claude-statusline <command>

Commands:
  setup      Configure ~/.claude/settings.json to use this statusline
  uninstall  Remove this statusline from ~/.claude/settings.json
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

} else if (cmd === undefined) {
  console.log(USAGE);
  process.exit(0);

} else {
  console.error(`Unknown command: ${cmd}`);
  console.log('\n' + USAGE);
  process.exit(1);
}
