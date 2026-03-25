const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const POSTINSTALL = path.join(__dirname, '../scripts/postinstall.js');
const PREUNINSTALL = path.join(__dirname, '../scripts/preuninstall.js');

describe('postinstall.js', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-post-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('always exits 0, even on failure', () => {
    // Point CLAUDE_CONFIG_DIR at a file (not a dir) to force a failure
    const fakePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fakePath, 'not a directory');
    const result = spawnSync(process.execPath, [POSTINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: fakePath, npm_config_global: 'true' }
    });
    expect(result.status).toBe(0);
  });

  test('exits 0 silently for non-global install', () => {
    const result = spawnSync(process.execPath, [POSTINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, npm_config_global: 'false' }
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
  });

  test('prints success message on global install', () => {
    const result = spawnSync(process.execPath, [POSTINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, npm_config_global: 'true' }
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('✓');
  });
});

describe('preuninstall.js', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-pre-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('always exits 0', () => {
    const result = spawnSync(process.execPath, [PREUNINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir }
    });
    expect(result.status).toBe(0);
  });

  test('produces no output', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'node /old.js' }
    }, null, 2));
    const result = spawnSync(process.execPath, [PREUNINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir }
    });
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('');
  });

  test('removes statusLine from settings.json', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      statusLine: { type: 'command', command: 'node /old.js' }
    }, null, 2));
    spawnSync(process.execPath, [PREUNINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir }
    });
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });
});
