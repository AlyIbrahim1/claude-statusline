const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '../scripts/config');
const POSTINSTALL_PATH = path.join(__dirname, '../scripts/postinstall');

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

  test('runs plugin autosetup on non-global install when CLAUDE_PLUGIN_ROOT is set', () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-plugin-root-'));
    fs.writeFileSync(path.join(pluginRoot, 'statusline.js'), '');

    try {
      const result = spawnSync(process.execPath, [POSTINSTALL], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: tmpDir,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          npm_config_global: 'false'
        }
      });

      expect(result.status).toBe(0);
      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
      expect(settings.statusLine).toBeDefined();
      expect(settings.statusLine.type).toBe('command');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test('prints success message on global install', () => {
    const result = spawnSync(process.execPath, [POSTINSTALL], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, npm_config_global: 'true' }
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('✓');
  });
});

describe('postinstall.js chmod behavior', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-chmod-'));
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    delete require.cache[require.resolve(CONFIG_PATH)];
    delete require.cache[require.resolve(POSTINSTALL_PATH)];
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    delete require.cache[require.resolve(CONFIG_PATH)];
    delete require.cache[require.resolve(POSTINSTALL_PATH)];
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.npm_config_global;
  });

  test('calls chmodSync with binary path and 0o755 when resolveBinary returns a path and platform is not win32', () => {
    const fakeBinary = path.join(tmpDir, 'claude-statusline');
    fs.writeFileSync(fakeBinary, '');

    const config = require(CONFIG_PATH);
    jest.spyOn(config, 'resolveBinary').mockReturnValue(fakeBinary);
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      delete require.cache[require.resolve(POSTINSTALL_PATH)];
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      process.env.npm_config_global = 'true';
      require(POSTINSTALL_PATH);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform || { value: 'linux', configurable: true });
    }

    expect(chmodSpy).toHaveBeenCalledWith(fakeBinary, 0o755);
  });

  test('does not call chmodSync when resolveBinary returns null', () => {
    const config = require(CONFIG_PATH);
    jest.spyOn(config, 'resolveBinary').mockReturnValue(null);
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      delete require.cache[require.resolve(POSTINSTALL_PATH)];
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      process.env.npm_config_global = 'true';
      require(POSTINSTALL_PATH);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform || { value: 'linux', configurable: true });
    }

    expect(chmodSpy).not.toHaveBeenCalled();
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
