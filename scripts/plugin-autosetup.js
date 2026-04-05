'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('./config');

// Only meaningful in plugin context — exit silently otherwise
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
if (!pluginRoot) process.exit(0);

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(configDir, 'settings.json');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {}

// Already configured — nothing to do
if (settings.statusLine) process.exit(0);

const script = path.join(pluginRoot, 'statusline.js');
if (!fs.existsSync(script)) process.exit(0);

settings.statusLine = {
  type: 'command',
  command: `"${process.execPath}" "${script}"`,
};

try {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  atomicWrite(settingsPath, settings);
} catch (e) {
  process.exit(0); // Non-fatal — user can run /claude-statusline:setup manually
}
