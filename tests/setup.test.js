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
    jest.spyOn(require('../scripts/config'), 'resolveBinary').mockReturnValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  test('returns error when settings.json is a JSON array', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify([{ bad: true }], null, 2));
    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not contain a JSON object/i);
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

  test('setup command output is unchanged when realtime env flag is enabled', () => {
    process.env.CLAUDE_STATUSLINE_REALTIME = '1';
    const result = load()();
    expect(result.ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('statusline.js');
    expect(settings.statusLine.command).not.toContain('realtime');
    delete process.env.CLAUDE_STATUSLINE_REALTIME;
  });

  test('setup command output is unchanged when realtime env flag is disabled', () => {
    process.env.CLAUDE_STATUSLINE_REALTIME = '0';
    const result = load()();
    expect(result.ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('statusline.js');
    expect(settings.statusLine.command).not.toContain('realtime');
    delete process.env.CLAUDE_STATUSLINE_REALTIME;
  });

  test('setup adds SessionStart and SessionEnd hooks', () => {
    const result = load()();
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('hook start');
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toContain('hook end');
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('--marker=claude-statusline-owned-v1');
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command)
      .toContain(`"${process.execPath}"`);
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command.startsWith('node ')).toBe(false);
  });

  test('hooks are not duplicated when setup is called a second time', () => {
    load()();
    load()();
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    // Each event should have exactly one hook entry, not two.
    expect(settings.hooks?.SessionStart?.length).toBe(1);
    expect(settings.hooks?.SessionEnd?.length).toBe(1);
  });

  test('setup preserves unrelated hooks in other events', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ type: 'command', command: 'echo pre' }],
      }
    }, null, 2));

    load()();

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks?.PreToolUse).toBeDefined();
    expect(settings.hooks?.SessionStart).toBeDefined();
  });

  test('returns error when hooks config contains invalid JSON', () => {
    const realReadFileSync = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
      if (String(filePath).endsWith(path.join('hooks', 'hooks.json'))) {
        return '{ invalid json }';
      }
      return realReadFileSync(filePath, encoding);
    });

    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Hook configuration error/i);
  });
});

describe('toggleHistory()', () => {
  let tmpDir, origConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-history-'));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    delete require.cache[require.resolve('../scripts/setup')];
    jest.spyOn(require('../scripts/config'), 'resolveBinary').mockReturnValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../scripts/setup').toggleHistory;

  test('enable adds SessionStart and SessionEnd hooks', () => {
    const result = load()(true);
    expect(result.ok).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('hook start');
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toContain('hook end');
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toContain('--marker=claude-statusline-owned-v1');
  });

  test('disable removes SessionStart and SessionEnd hooks', () => {
    load()(true);
    const result = load()(false);
    expect(result.ok).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks).toBeUndefined();
  });

  test('enable writes hook commands with absolute node executable path', () => {
    const result = load()(true);
    expect(result.ok).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    const startCommand = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command || '';
    expect(startCommand).toContain(`"${process.execPath}"`);
    expect(startCommand.startsWith('node ')).toBe(false);
  });

  test('disable preserves unrelated hooks', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ type: 'command', command: 'echo pre' }],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'old hook start' }] }]
      }
    }, null, 2));
    load()(false);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks?.PreToolUse).toBeDefined();
    expect(written.hooks?.SessionStart).toBeDefined();
  });

  test('disable removes legacy statusline hook commands', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'statusline hook start' }] }]
      }
    }, null, 2));
    load()(false);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks?.SessionStart).toBeUndefined();
  });

  test('returns error on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad }');
    const result = load()(true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid JSON/i);
  });

  test('returns error when settings.json is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(['bad'], null, 2));
    const result = load()(true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not contain a JSON object/i);
  });
});

describe('getDashboardMode()', () => {
  let tmpDir, origConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-getmode-'));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    delete require.cache[require.resolve('../scripts/setup')];
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../scripts/setup').getDashboardMode;

  test('returns web when settings.json does not exist', () => {
    const result = load()();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('web');
  });

  test('returns terminal when settings has dashboardMode: terminal', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'),
      JSON.stringify({ dashboardMode: 'terminal' }, null, 2));
    const result = load()();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('terminal');
  });

  test('returns web when settings has dashboardMode: web', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'),
      JSON.stringify({ dashboardMode: 'web' }, null, 2));
    expect(load()().mode).toBe('web');
  });

  test('defaults to web for any unrecognised dashboardMode value', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'),
      JSON.stringify({ dashboardMode: 'unknown' }, null, 2));
    expect(load()().mode).toBe('web');
  });

  test('returns error when settings.json contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad }');
    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid JSON/i);
  });

  test('returns error when settings.json is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(['bad'], null, 2));
    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not contain a JSON object/i);
  });

  test('includes settingsPath in result', () => {
    const result = load()();
    expect(result.settingsPath).toContain('settings.json');
  });
});

describe('setDashboardMode()', () => {
  let tmpDir, origConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-setmode-'));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    delete require.cache[require.resolve('../scripts/setup')];
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../scripts/setup').setDashboardMode;

  test('writes dashboardMode: web to settings.json', () => {
    const result = load()('web');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('web');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.dashboardMode).toBe('web');
  });

  test('writes dashboardMode: terminal to settings.json', () => {
    const result = load()('terminal');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('terminal');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.dashboardMode).toBe('terminal');
  });

  test('preserves other settings keys when writing mode', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', statusLine: { type: 'command', command: '"bin"' } }, null, 2));
    load()('web');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.model).toBe('sonnet');
    expect(settings.statusLine).toBeDefined();
    expect(settings.dashboardMode).toBe('web');
  });

  test('creates settings.json when it does not exist', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
    load()('terminal');
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  test('returns error for invalid mode value', () => {
    const result = load()('invalid');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid mode/i);
  });

  test('returns error when settings.json contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad }');
    const result = load()('web');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid JSON/i);
  });

  test('returns error when settings.json is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(['bad'], null, 2));
    const result = load()('terminal');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not contain a JSON object/i);
  });
});
