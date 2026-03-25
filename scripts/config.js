'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function getSettingsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = (configDir && configDir.trim())
    ? configDir
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

function atomicWrite(filePath, obj) {
  const tmpPath = filePath + '.tmp';
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    throw err;
  }
}

module.exports = { getSettingsPath, atomicWrite };
