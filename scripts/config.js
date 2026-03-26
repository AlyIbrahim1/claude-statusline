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

/**
 * Resolves the path to the platform-specific binary, or returns null if not found.
 * @returns {string|null}
 */
function resolveBinary() {
  const platformKey = `${process.platform}-${process.arch}`;
  const pkgName = `@alyibrahim/claude-statusline-${platformKey}`;
  const binName = process.platform === 'win32' ? 'statusline.exe' : 'statusline';
  let binaryPath = null;
  try {
    const pkgJson = require.resolve(`${pkgName}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), binName);
    if (fs.existsSync(candidate)) binaryPath = candidate;
  } catch (e) {}
  return binaryPath;
}

module.exports = { getSettingsPath, atomicWrite, resolveBinary };
