'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function getClaudeConfigDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return (configDir && configDir.trim())
    ? configDir
    : path.join(os.homedir(), '.claude');
}

function sanitizeSlug(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getRealtimeTtySlug() {
  const preferred = [process.env.CLAUDE_STATUSLINE_TTY, process.env.TERM_SESSION_ID];
  for (const raw of preferred) {
    const slug = sanitizeSlug(raw || '');
    if (slug) return slug;
  }
  return sanitizeSlug(`pid-${process.pid}`);
}

function getRealtimePaths() {
  const claudeDir = getClaudeConfigDir();
  const ttySlug = getRealtimeTtySlug();
  return {
    claudeDir,
    ttySlug,
    registryPath: path.join(claudeDir, `statusline-renderer-${ttySlug}.json`),
    statePath: path.join(claudeDir, `statusline-state-${ttySlug}.json`),
    socketPath: path.join(claudeDir, `statusline-rt-${ttySlug}.sock`),
  };
}

function getSettingsPath() {
  const base = getClaudeConfigDir();
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

module.exports = {
  getSettingsPath,
  atomicWrite,
  resolveBinary,
  getClaudeConfigDir,
  getRealtimeTtySlug,
  getRealtimePaths,
};
