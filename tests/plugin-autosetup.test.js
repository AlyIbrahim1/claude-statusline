'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '../scripts/plugin-autosetup.js');

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
}

describe('plugin-autosetup.js', () => {
  let tmpDir, pluginDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-autosetup-'));
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-plugin-'));
    // Provide a fake statusline.js in the plugin root
    fs.writeFileSync(path.join(pluginDir, 'statusline.js'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('exits 0 silently when CLAUDE_PLUGIN_ROOT is not set', () => {
    const env = { CLAUDE_CONFIG_DIR: tmpDir };
    delete env.CLAUDE_PLUGIN_ROOT;
    const result = run(env);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
  });

  test('exits 0 and writes statusLine when not previously configured', () => {
    const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    expect(result.status).toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeDefined();
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.command).toContain('statusline.js');
  });

  test('statusLine command quotes both node path and script path', () => {
    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toMatch(/^".+" ".+"$/);
  });

  test('does nothing when statusLine is already set', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const existing = { statusLine: { type: 'command', command: '"existing-tool"' } };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.statusLine.command).toBe('"existing-tool"');
  });

  test('preserves existing settings keys', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', theme: 'dark' }, null, 2));

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.model).toBe('sonnet');
    expect(settings.theme).toBe('dark');
    expect(settings.statusLine).toBeDefined();
  });

  test('exits 0 silently when statusline.js is absent from plugin root', () => {
    const emptyPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-empty-plugin-'));
    try {
      const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: emptyPluginDir });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
    } finally {
      fs.rmSync(emptyPluginDir, { recursive: true, force: true });
    }
  });

  test('handles invalid JSON in existing settings.json gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad json }');
    const result = run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    expect(result.status).toBe(0);
    // Invalid JSON means settings read as {}, statusLine gets written
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeDefined();
  });

  test('creates settings.json when it does not exist', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });

    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  test('is idempotent — second run does not overwrite', () => {
    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    const after1 = fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8');

    run({ CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_PLUGIN_ROOT: pluginDir });
    const after2 = fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8');

    expect(after1).toBe(after2);
  });
});
