'use strict';
const fs = require('fs');
const { getSettingsPath, atomicWrite } = require('./config');

function uninstall() {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return { ok: true };

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'settings.json contains invalid JSON — cannot safely modify.' };
  }

  if (!settings.statusLine) return { ok: true };
  delete settings.statusLine;

  try {
    atomicWrite(settingsPath, settings);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true };
}

module.exports = { uninstall };
