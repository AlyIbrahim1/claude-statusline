'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, resolveBinary, isPlainObject } = require('./config');

// force: replace an existing statusLine (the explicit /setup command); installs never do.
function pluginAutoSetup(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT, { force = false } = {}) {
  // Only meaningful in plugin context.
  if (!pluginRoot) return { ok: true, configured: false };

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(configDir, 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    // Never rewrite a settings file we can't parse: that would drop the user's other settings.
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return { ok: false, configured: false, error: 'settings.json contains invalid JSON — fix manually then re-run.' };
    }
    if (!isPlainObject(settings)) {
      return { ok: false, configured: false, error: 'settings.json does not contain a JSON object — fix manually then re-run.' };
    }
  }

  // Already configured; leave user config untouched.
  if (settings.statusLine && !force) return { ok: true, configured: false };

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
  const force = process.argv.includes('--force');
  const result = pluginAutoSetup(undefined, { force });
  if (force) {
    // Explicit /setup: report the outcome.
    if (result.error) console.error(`Error: ${result.error}`);
    else if (result.configured) console.log('✓ claude-statusline configured. Restart Claude Code to see it.');
    else console.error('Could not configure: run this from the plugin (CLAUDE_PLUGIN_ROOT unset) or reinstall it.');
  }
  process.exit(0); // never fail plugin startup
}
