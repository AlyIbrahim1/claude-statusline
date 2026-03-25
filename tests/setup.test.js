const fs = require('fs');
const os = require('os');
const path = require('path');

describe('setup()', () => {
  let tmpDir, origConfigDir, origNpmGlobal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-setup-'));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    origNpmGlobal = process.env.npm_config_global;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    process.env.npm_config_global = 'true';
    delete require.cache[require.resolve('../scripts/setup')];
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    if (origNpmGlobal === undefined) delete process.env.npm_config_global;
    else process.env.npm_config_global = origNpmGlobal;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../scripts/setup').setup;

  test('CI guard: returns { ok: true, settingsPath: null } when npm_config_global is not true and force is false', () => {
    process.env.npm_config_global = 'false';
    const result = load()({ force: false });
    expect(result).toEqual({ ok: true, settingsPath: null });
    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false);
  });

  test('force: bypasses CI guard when force is true', () => {
    process.env.npm_config_global = 'false';
    const result = load()({ force: true });
    expect(result.ok).toBe(true);
    expect(result.settingsPath).toBeTruthy();
  });

  test('creates settings.json with statusLine when file is missing', () => {
    const result = load()();
    expect(result.ok).toBe(true);
    expect(result.settingsPath).toBe(path.join(tmpDir, 'settings.json'));
    const written = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(written.statusLine).toBeDefined();
    expect(written.statusLine.type).toBe('command');
    expect(written.statusLine.command).toContain('statusline.js');
  });

  test('command double-quotes both execPath and scriptPath', () => {
    const result = load()();
    const written = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(written.statusLine.command).toMatch(/^".+" ".+"$/);
  });

  test('preserves existing settings keys', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', theme: 'dark' }, null, 2));
    load()();
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.model).toBe('sonnet');
    expect(written.theme).toBe('dark');
    expect(written.statusLine).toBeDefined();
  });

  test('overwrites statusLine silently if already set (idempotent)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'old-command' }
    }, null, 2));
    const result = load()();
    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine.command).not.toBe('old-command');
  });

  test('returns error when settings.json contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ invalid }');
    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid JSON/i);
  });

  test('uses binary path when platform package is installed', () => {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-setup-binary-'));
    const fakeBin = path.join(fakeDir, 'statusline');
    fs.writeFileSync(fakeBin, '');

    jest.spyOn(require('../scripts/config'), 'resolveBinary').mockReturnValue(fakeBin);

    delete require.cache[require.resolve('../scripts/setup')];
    require('../scripts/setup').setup();

    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toBe(`"${fakeBin}"`);

    jest.restoreAllMocks();
    fs.rmSync(fakeDir, { recursive: true });
  });

  test('falls back to node scriptPath when no binary found', () => {
    jest.spyOn(require('../scripts/config'), 'resolveBinary').mockReturnValue(null);

    delete require.cache[require.resolve('../scripts/setup')];
    require('../scripts/setup').setup();

    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toMatch(/node.*statusline\.js/);

    jest.restoreAllMocks();
  });
});
