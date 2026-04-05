'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getSettingsPath, atomicWrite } = config;

const UNSAFE_CHARS = /["`$!()\\]/;

function buildNodeExecCommand() {
  return `"${process.execPath}"`;
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

  try {
    updateHooks(settings, true, { nodeExecCommand: buildNodeExecCommand() });
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

function updateHooks(settings, enable, { nodeExecCommand = buildNodeExecCommand() } = {}) {
  if (!settings.hooks) settings.hooks = {};

  const packageRoot = path.resolve(__dirname, '..');
  const escapedRoot = packageRoot.replace(/\\/g, '\\\\');
  const escapedNodeExec = nodeExecCommand
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  // When installing, only add history hooks from hooks.json.
  // When removing, read all our hooks files so every hook we may have written gets cleaned up.
  const installFile = path.join(packageRoot, 'hooks', 'hooks.json');
  const allFiles = [
    installFile,
    path.join(packageRoot, 'hooks', 'plugin-setup.json'),
  ].filter(f => fs.existsSync(f));
  const filesToProcess = enable ? [installFile] : allFiles;

  // Collect every resolved command across all our hooks files for exact-match removal.
  const ourCommands = new Set();
  for (const f of allFiles) {
    const resolved = resolveHooksFromFile(f, {
      CLAUDE_PLUGIN_ROOT: escapedRoot,
      CLAUDE_NODE_EXEC: escapedNodeExec,
    });
    for (const entries of Object.values(resolved)) {
      for (const entry of entries) {
        for (const hook of (entry.hooks || [])) {
          if (hook.command) ourCommands.add(hook.command);
        }
      }
    }
  }

  for (const f of filesToProcess) {
    const resolvedHooks = resolveHooksFromFile(f, {
      CLAUDE_PLUGIN_ROOT: escapedRoot,
      CLAUDE_NODE_EXEC: escapedNodeExec,
    });

    for (const [event, entries] of Object.entries(resolvedHooks)) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      settings.hooks[event] = settings.hooks[event].filter(h => {
        const isLegacyAutosetup = cmd => {
          if (!cmd) return false;
          const hasScript = /scripts[\\/]+plugin-autosetup\.js/.test(cmd);
          const hasOwnedMarker = /claude-statusline|CLAUDE_PLUGIN_ROOT/i.test(cmd);
          return hasScript && hasOwnedMarker;
        };
        const isOurs = inner => inner.command && (
          // Suffix match — catches hooks written by older package versions
          inner.command.endsWith(' hook start') || inner.command.endsWith(' hook end') ||
          // Exact match — catches current hooks including plugin-setup entries
          ourCommands.has(inner.command) ||
          // Legacy autosetup fallback — catches prior install roots
          isLegacyAutosetup(inner.command)
        );
        if (h.hooks) return !h.hooks.some(isOurs);
        return !isOurs(h);
      });
      if (enable) {
        settings.hooks[event].push(...entries);
      }
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
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
  }

  try {
    updateHooks(settings, enable, { nodeExecCommand: buildNodeExecCommand() });
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
