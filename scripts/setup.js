'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getSettingsPath, atomicWrite } = config;

const UNSAFE_CHARS = /["`$!()\\]/;

function setup({ force = false } = {}) {
  // CI guard: skip during local/CI npm installs unless forced (e.g. from CLI)
  if (!force && process.env.npm_config_global !== 'true') {
    return { ok: true, settingsPath: null };
  }

  const scriptPath = path.resolve(__dirname, '../statusline.js');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `Could not locate statusline.js at ${scriptPath}` };
  }

  if (UNSAFE_CHARS.test(process.execPath) || UNSAFE_CHARS.test(scriptPath)) {
    return { ok: false, error: 'Node.js path or install path contains unsupported characters.' };
  }

  const settingsPath = getSettingsPath();
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'settings.json contains invalid JSON — fix manually then re-run.' };
    }
  }

  const binaryPath = config.resolveBinary();
  const safeBinary = binaryPath && !UNSAFE_CHARS.test(binaryPath) ? binaryPath : null;
  const command = safeBinary
    ? `"${safeBinary}"`
    : `"${process.execPath}" "${scriptPath}"`;
  settings.statusLine = { type: 'command', command };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath };
}

module.exports = { setup };
