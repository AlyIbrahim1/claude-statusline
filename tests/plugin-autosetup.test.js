'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '../scripts/plugin-autosetup.js');

// Helper for subprocess-based tests. Merges env on top of process.env.
function run(env) {
  return spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
}

// Helper that explicitly removes CLAUDE_PLUGIN_ROOT so parent env can't bleed in.
function runWithoutPluginRoot(env) {
  const { CLAUDE_PLUGIN_ROOT: _removed, ...baseEnv } = process.env;
  return spawnSync(process.execPath, [SCRIPT], { env: { ...baseEnv, ...env } });
}

describe('plugin-autosetup.js (subprocess)', () => {
  let tmpDir, pluginDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-autosetup-'));
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-plugin-'));
    fs.writeFileSync(path.join(pluginDir, 'statusline.js'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('exits 0 silently when CLAUDE_PLUGIN_ROOT is not set', () => {
    // Use explicit env removal so the parent process CLAUDE_PLUGIN_ROOT cannot bleed through.
    const result = runWithoutPluginRoot({ CLAUDE_CONFIG_DIR: tmpDir });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
  });

  test('exits 0 and writes settings.json with statusLine when not previously configured', () => {
    const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    expect(result.status).toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeDefined();
    expect(settings.statusLine.type).toBe('command');
    // Binary found: `"path/to/binary"` — JS fallback: `"node" "script.js"`
    expect(settings.statusLine.command).toMatch(/^"[^"]+"( "[^"]+")?$/);
  });

  test('does nothing when statusLine is already set', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const existing = { statusLine: { type: 'command', command: '"existing-tool"' } };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.statusLine.command).toBe('"existing-tool"');
  });

  test('preserves existing settings keys when writing statusLine', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', theme: 'dark' }, null, 2));

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.model).toBe('sonnet');
    expect(settings.theme).toBe('dark');
    expect(settings.statusLine).toBeDefined();
  });

  test('exits 0 silently when neither binary nor statusline.js is available', () => {
    const emptyPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-empty-plugin-'));
    try {
      const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: emptyPluginDir });
      expect(result.status).toBe(0);
      // When the platform binary is installed, it is used even without statusline.js.
      // Only skip configuration when neither the binary nor the script is found.
      const { resolveBinary } = require('../scripts/config');
      if (!resolveBinary()) {
        expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
      }
    } finally {
      fs.rmSync(emptyPluginDir, { recursive: true, force: true });
    }
  });

  test('handles invalid JSON in existing settings.json gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad json }');
    const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    expect(result.status).toBe(0);
    // Invalid JSON means settings read as {}, statusLine gets written.
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeDefined();
  });

  test('creates settings.json and parent directory when they do not exist', () => {
    const nestedConfigDir = path.join(tmpDir, 'deep', 'dir');
    const result = run({ CLAUDE_CONFIG_DIR: nestedConfigDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(nestedConfigDir, 'settings.json'))).toBe(true);
  });

  test('is idempotent — second run does not overwrite existing statusLine', () => {
    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    const after1 = fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8');

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    const after2 = fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8');

    expect(after1).toBe(after2);
  });
});

// Unit-level tests using the exported function with mocked resolveBinary.
// These verify the binary-vs-fallback selection logic without spawning subprocesses.
describe('pluginAutoSetup() function export', () => {
  let tmpDir, pluginDir, origConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-autosetup-unit-'));
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-plugin-unit-'));
    fs.writeFileSync(path.join(pluginDir, 'statusline.js'), '');
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  function loadWithBinary(binaryPath) {
    jest.doMock('../scripts/config', () => ({
      ...jest.requireActual('../scripts/config'),
      resolveBinary: () => binaryPath,
    }));
    return require('../scripts/plugin-autosetup').pluginAutoSetup;
  }

  test('uses binary path as the sole quoted command when resolveBinary returns a path', () => {
    const fakeBin = path.join(tmpDir, 'statusline');
    fs.writeFileSync(fakeBin, '');

    const pluginAutoSetup = loadWithBinary(fakeBin);
    const result = pluginAutoSetup(pluginDir);

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toBe(`"${fakeBin}"`);
  });

  test('uses node + script path as fallback when no binary is found', () => {
    const pluginAutoSetup = loadWithBinary(null);
    const result = pluginAutoSetup(pluginDir);

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toMatch(/^"[^"]+" ".+statusline\.js"$/);
  });

  test('returns configured:false without writing settings when no binary and no script', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-empty-unit-'));
    try {
      const pluginAutoSetup = loadWithBinary(null);
      const result = pluginAutoSetup(emptyDir);

      expect(result).toEqual({ ok: true, configured: false });
      expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('returns configured:false immediately when pluginRoot is falsy', () => {
    const pluginAutoSetup = loadWithBinary(null);
    expect(pluginAutoSetup(null)).toEqual({ ok: true, configured: false });
    expect(pluginAutoSetup('')).toEqual({ ok: true, configured: false });
    expect(pluginAutoSetup(undefined)).toEqual({ ok: true, configured: false });
  });

  test('returns configured:false without writing when statusLine already exists', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: '"existing"' }
    }, null, 2));

    const pluginAutoSetup = loadWithBinary(null);
    const result = pluginAutoSetup(pluginDir);

    expect(result).toEqual({ ok: true, configured: false });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.statusLine.command).toBe('"existing"');
  });
});
