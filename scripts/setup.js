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

  updateHooks(settings, command, true);

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath };
}

function updateHooks(settings, command, enable) {
  if (!settings.hooks) settings.hooks = {};
  
  const startCmd = `${command} hook start`;
  const endCmd = `${command} hook end`;

  function toggleHook(hookName, cmdString) {
    if (!settings.hooks[hookName]) settings.hooks[hookName] = [];
    // Remove any existing statusline hook entries (both old and new format)
    settings.hooks[hookName] = settings.hooks[hookName].filter(h => {
      if (h.hooks) {
        return !h.hooks.some(inner => inner.command && (inner.command.includes('hook start') || inner.command.includes('hook end')));
      }
      return !(h.command && (h.command.includes('hook start') || h.command.includes('hook end')));
    });
    if (enable) {
      settings.hooks[hookName].push({ matcher: '', hooks: [{ type: 'command', command: cmdString }] });
    }
    if (settings.hooks[hookName].length === 0) {
      delete settings.hooks[hookName];
    }
  }

  toggleHook('SessionStart', startCmd);
  toggleHook('SessionEnd', endCmd);

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
}

function toggleHistory(enable) {
  const scriptPath = path.resolve(__dirname, '../statusline.js');
  const binaryPath = config.resolveBinary();
  const safeBinary = binaryPath && !UNSAFE_CHARS.test(binaryPath) ? binaryPath : null;
  const command = safeBinary ? `"${safeBinary}"` : `"${process.execPath}" "${scriptPath}"`;

  const settingsPath = getSettingsPath();
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'settings.json contains invalid JSON — fix manually then re-run.' };
    }
  }

  updateHooks(settings, command, enable);

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath };
}

module.exports = { setup, toggleHistory, updateHooks };
