'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

function downloadBinary() {
  const platformKey = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(platformKey)) {
    return {
      ok: false,
      error: `No pre-built binary for ${platformKey}. The JS fallback will be used.`
    };
  }

  const { version } = require('../package.json');
  const packageRoot = path.resolve(__dirname, '..');
  const packageSpec = `@alyibrahim/claude-statusline-${platformKey}@${version}`;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const installResult = spawnSync(npmCmd, ['install', '--no-save', packageSpec], {
    cwd: packageRoot,
    stdio: 'inherit'
  });

  if (installResult.status !== 0) {
    return {
      ok: false,
      error: `npm install exited with code ${installResult.status}`
    };
  }

  // Clear cached modules so resolveBinary sees newly installed optional dependency.
  const platformPkg = `claude-statusline-${platformKey}`;
  Object.keys(require.cache).forEach((cacheKey) => {
    if (cacheKey.includes(platformPkg)) {
      delete require.cache[cacheKey];
    }
  });

  const { resolveBinary } = require('./config');
  const binaryPath = resolveBinary();
  if (!binaryPath) {
    return {
      ok: false,
      error: 'Package installed but binary not found - unexpected layout'
    };
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch (e) {}
  }

  return { ok: true, binaryPath };
}

module.exports = { downloadBinary };
