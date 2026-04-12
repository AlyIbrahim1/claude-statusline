'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../scripts/check-version-alignment.js');

function run(dir) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHECK_VERSIONS_ROOT: dir },
    encoding: 'utf8',
  });
}

function writeFiles(dir, { pkgVersion, cargoVersion, pluginVersion, marketplaceVersion, optionalDepVersion }) {
  const pkg = {
    name: '@alyibrahim/claude-statusline',
    version: pkgVersion,
    optionalDependencies: {
      '@alyibrahim/claude-statusline-linux-x64': optionalDepVersion,
      '@alyibrahim/claude-statusline-darwin-arm64': optionalDepVersion,
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // Minimal package-lock.json matching the expected structure
  const lock = {
    name: '@alyibrahim/claude-statusline',
    version: pkgVersion,
    lockfileVersion: 3,
    packages: {
      '': {
        version: pkgVersion,
        optionalDependencies: {
          '@alyibrahim/claude-statusline-linux-x64': optionalDepVersion,
          '@alyibrahim/claude-statusline-darwin-arm64': optionalDepVersion,
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));

  fs.writeFileSync(path.join(dir, 'Cargo.toml'), `[package]\nname = "claude-statusline"\nversion = "${cargoVersion}"\nedition = "2021"\n`);

  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'claude-statusline', version: pluginVersion }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'claude-statusline', version: marketplaceVersion }] }, null, 2)
  );
}

describe('check-version-alignment.js', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-check-ver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exits 0 when all versions align including optionalDependencies', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.1',
      pluginVersion: '1.6.1',
      marketplaceVersion: '1.6.1',
      optionalDepVersion: '1.6.1',
    });
    const result = run(tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK (version 1.6.1)');
  });

  test('fails when optionalDependencies are pinned to a different version than root', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.1',
      pluginVersion: '1.6.1',
      marketplaceVersion: '1.6.1',
      optionalDepVersion: '1.5.4',  // stale — not bumped with root
    });
    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/optionalDependencies\[.*\].*1\.5\.4.*expected.*1\.6\.1/);
  });

  test('fails when Cargo.toml version differs from package.json', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.0',
      pluginVersion: '1.6.1',
      marketplaceVersion: '1.6.1',
      optionalDepVersion: '1.6.1',
    });
    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cargo.toml version 1.6.0');
  });

  test('fails when plugin.json version differs', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.1',
      pluginVersion: '1.6.0',
      marketplaceVersion: '1.6.1',
      optionalDepVersion: '1.6.1',
    });
    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plugin.json version 1.6.0');
  });

  test('fails when marketplace.json version differs', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.1',
      pluginVersion: '1.6.1',
      marketplaceVersion: '1.6.0',
      optionalDepVersion: '1.6.1',
    });
    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('marketplace.json plugins[0].version 1.6.0');
  });

  test('fails when multiple versions are misaligned — reports all errors', () => {
    writeFiles(tmpDir, {
      pkgVersion: '1.6.1',
      cargoVersion: '1.6.0',
      pluginVersion: '1.6.0',
      marketplaceVersion: '1.6.1',
      optionalDepVersion: '1.5.4',
    });
    const result = run(tmpDir);
    expect(result.status).toBe(1);
    // All three errors should appear in output
    expect(result.stderr).toContain('Cargo.toml');
    expect(result.stderr).toContain('plugin.json');
    expect(result.stderr).toContain('optionalDependencies');
  });
});
