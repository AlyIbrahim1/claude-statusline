'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, resolveBinary } = require('./config');

function pluginAutoSetup(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT) {
  // Only meaningful in plugin context.
  if (!pluginRoot) return { ok: true, configured: false };

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(configDir, 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {}

  // Already configured; leave user config untouched.
  if (settings.statusLine) return { ok: true, configured: false };

  const script = path.join(pluginRoot, 'statusline.js');
  const binaryPath = resolveBinary();
  if (!binaryPath && !fs.existsSync(script)) return { ok: true, configured: false };

  const command = binaryPath
    ? `"${binaryPath}"`
    : `"${process.execPath}" "${script}"`;

  settings.statusLine = {
    type: 'command',
    command,
  };

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWrite(settingsPath, settings);
  } catch (e) {
    return { ok: true, configured: false }; // Non-fatal.
  }

  return { ok: true, configured: true };
}

module.exports = { pluginAutoSetup };

if (require.main === module) {
  pluginAutoSetup();
  process.exit(0); // never fail plugin startup
}
