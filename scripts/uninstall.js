'use strict';
const fs = require('fs');
const path = require('path');
const { getSettingsPath, getClaudeConfigDir, atomicWrite, isPlainObject } = require('./config');

// removeData also deletes <config>/statusline/ (history, session state, dashboard). Only the
// explicit CLI command passes it; npm lifecycle hooks may run during upgrades.
function uninstall({ removeData = false } = {}) {
  if (removeData) {
    fs.rmSync(path.join(getClaudeConfigDir(), 'statusline'), { recursive: true, force: true });
  }
  const settingsPath = getSettingsPath();
  // Slash commands copied by postinstall (same names as the package's .claude/commands).
  const commandsDir = path.join(path.dirname(settingsPath), 'commands');
  for (const f of fs.readdirSync(path.join(__dirname, '..', '.claude', 'commands'))) {
    fs.rmSync(path.join(commandsDir, f), { force: true });
  }
  try { fs.rmdirSync(commandsDir); } catch (e) {} // only succeeds when nothing else is in it
  if (!fs.existsSync(settingsPath)) return { ok: true };

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'settings.json contains invalid JSON — cannot safely modify.' };
  }
  if (!isPlainObject(settings)) {
    return { ok: false, error: 'settings.json does not contain a JSON object — cannot safely modify.' };
  }

  delete settings.statusLine;
  if (removeData) delete settings.dashboardMode;

  // Also strip our hooks if they exist
  const { updateHooks } = require('./setup');
  try {
    updateHooks(settings, false);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true };
}

module.exports = { uninstall };
