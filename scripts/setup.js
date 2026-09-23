'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getSettingsPath, atomicWrite, isPlainObject } = config;

const HOOK_MARKER = 'claude-statusline-owned-v1';

// Characters that break or get expanded inside a double-quoted shell string. On Windows,
// backslashes are the path separator and "Program Files (x86)" is common; both are safe in quotes.
function unsafeChars() {
  return process.platform === 'win32' ? /["`$!]/ : /["`$!()\\]/;
}

// What Claude Code runs for both the statusline and the history hook: the native binary when
// installed, else node + statusline.js. Null when no safe command can be built.
function statuslineCommand() {
  const unsafe = unsafeChars();
  const binaryPath = config.resolveBinary();
  if (binaryPath && !unsafe.test(binaryPath)) return `"${binaryPath}"`;
  const scriptPath = path.resolve(__dirname, '../statusline.js');
  if (unsafe.test(process.execPath) || unsafe.test(scriptPath)) return null;
  return `"${process.execPath}" "${scriptPath}"`;
}

function resolveHooksFromFile(filePath, replacements) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const wrapped = new Error(`Hook configuration error in ${path.basename(filePath)}: ${err.message}`);
    wrapped.code = 'HOOK_CONFIG_ERROR';
    throw wrapped;
  }

  const hooks = parsed && parsed.hooks;
  if (!hooks || typeof hooks !== 'object') {
    const wrapped = new Error(`Hook configuration error in ${path.basename(filePath)}: missing hooks object`);
    wrapped.code = 'HOOK_CONFIG_ERROR';
    throw wrapped;
  }

  let serialized = JSON.stringify(hooks);
  for (const [token, value] of Object.entries(replacements)) {
    serialized = serialized.replace(new RegExp(`\\$\\{${token}\\}`, 'g'), value);
  }

  return JSON.parse(serialized);
}

function setup({ force = false } = {}) {
  // CI guard: skip during local/CI npm installs unless forced (e.g. from CLI)
  if (!force && process.env.npm_config_global !== 'true') {
    return { ok: true, settingsPath: null };
  }

  const scriptPath = path.resolve(__dirname, '../statusline.js');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `Could not locate statusline.js at ${scriptPath}` };
  }

  const command = statuslineCommand();
  if (!command) {
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
    if (!isPlainObject(settings)) {
      return { ok: false, error: 'settings.json does not contain a JSON object — fix manually then re-run.' };
    }
  }

  settings.statusLine = { type: 'command', command };

  try {
    updateHooks(settings, true, { command });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath };
}

function updateHooks(settings, enable, { command = statuslineCommand() } = {}) {
  if (!settings.hooks) settings.hooks = {};
  if (enable && !command) {
    throw new Error('Node.js path or install path contains unsupported characters.');
  }

  // Values are substituted into JSON text, so they must be JSON-escaped.
  const resolvedHooks = resolveHooksFromFile(path.join(__dirname, '..', 'hooks', 'hooks.json'), {
    STATUSLINE_CMD: JSON.stringify(command || '').slice(1, -1),
    HOOK_MARKER,
  });
  const ourCommands = new Set();
  for (const entries of Object.values(resolvedHooks)) {
    for (const entry of entries) {
      for (const hook of (entry.hooks || [])) {
        if (hook.command) ourCommands.add(hook.command);
      }
    }
  }

  const isLegacyAutosetup = cmd => {
    if (!cmd) return false;
    const hasScript = /scripts[\\/]+plugin-autosetup\.js/.test(cmd);
    const hasOwnedMarker = /claude-statusline|CLAUDE_PLUGIN_ROOT/i.test(cmd);
    return hasScript && hasOwnedMarker;
  };
  const hasOwnedMarker = cmd => cmd && cmd.includes(`--marker=${HOOK_MARKER}`);
  const isLegacyStatuslineHook = cmd => {
    if (!cmd) return false;
    const isHookSuffix = cmd.endsWith(' hook start') || cmd.endsWith(' hook end');
    if (!isHookSuffix) return false;
    // Keep backward compatibility with older commands while avoiding broad suffix-only matches.
    return /(?:^|\s)(?:statusline|claude-statusline)(?:\s|$)/i.test(cmd);
  };
  const isOurs = inner => inner.command && (
    // Marker match — canonical ownership check for new installs.
    hasOwnedMarker(inner.command) ||
    // Exact match — catches current hooks including plugin-setup entries
    ourCommands.has(inner.command) ||
    // Backward-compatible statusline suffix match for older package versions.
    isLegacyStatuslineHook(inner.command) ||
    // Legacy autosetup fallback — catches prior install roots
    isLegacyAutosetup(inner.command)
  );

  // Remove our hooks from every event (older versions also registered SessionStart).
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(h => (h.hooks ? !h.hooks.some(isOurs) : !isOurs(h)));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (enable) {
    for (const [event, entries] of Object.entries(resolvedHooks)) {
      settings.hooks[event] = [...(settings.hooks[event] || []), ...entries];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
}

function toggleHistory(enable) {
  const settingsPath = getSettingsPath();
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'settings.json contains invalid JSON — fix manually then re-run.' };
    }
    if (!isPlainObject(settings)) {
      return { ok: false, error: 'settings.json does not contain a JSON object — fix manually then re-run.' };
    }
  }

  try {
    updateHooks(settings, enable);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath };
}

function getDashboardMode() {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { ok: true, settingsPath, mode: 'web' };
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'settings.json contains invalid JSON - fix manually then re-run.' };
  }
  if (!isPlainObject(settings)) {
    return { ok: false, error: 'settings.json does not contain a JSON object - fix manually then re-run.' };
  }

  const mode = settings.dashboardMode === 'terminal' ? 'terminal' : 'web';
  return { ok: true, settingsPath, mode };
}

function setDashboardMode(mode) {
  if (mode !== 'web' && mode !== 'terminal') {
    return { ok: false, error: 'Invalid mode. Expected "web" or "terminal".' };
  }

  const settingsPath = getSettingsPath();
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'settings.json contains invalid JSON - fix manually then re-run.' };
    }
    if (!isPlainObject(settings)) {
      return { ok: false, error: 'settings.json does not contain a JSON object - fix manually then re-run.' };
    }
  }

  settings.dashboardMode = mode;

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, settingsPath, mode };
}

module.exports = { setup, toggleHistory, updateHooks, getDashboardMode, setDashboardMode };
