const fs = require('fs');
const os = require('os');
const path = require('path');

describe('uninstall()', () => {
  let tmpDir, origConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-uninstall-'));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    delete require.cache[require.resolve('../scripts/uninstall')];
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../scripts/uninstall').uninstall;

  test('returns ok when settings.json does not exist', () => {
    expect(load()()).toEqual({ ok: true });
  });

  test('returns ok when statusLine key is absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet' }, null, 2));
    expect(load()()).toEqual({ ok: true });
  });

  test('removes statusLine and preserves other keys', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      statusLine: { type: 'command', command: 'node /some/path.js' }
    }, null, 2));
    const result = load()();
    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });

  test('returns error when settings.json contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad json }');
    const result = load()();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid JSON/i);
  });

  test('removes hooks from settings.json', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      statusLine: { type: 'command', command: 'node /some/path.js' },
      hooks: {
        SessionStart: [{ type: 'command', command: 'statusline hook start' }],
        SessionEnd: [{ type: 'command', command: 'statusline hook end' }]
      }
    }, null, 2));
    load()();
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });

  test('removes autosetup hook from settings.json', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const packageRoot = path.resolve(__dirname, '..');
    const autosetupCmd = `node "${path.join(packageRoot, 'scripts', 'plugin-autosetup.js')}"`;
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: autosetupCmd }] }]
      }
    }, null, 2));
    load()();
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });

  test('removes legacy autosetup hook from old install root', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const oldCmd = 'node "/opt/old/claude-statusline/scripts/plugin-autosetup.js"';
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: oldCmd }] }]
      }
    }, null, 2));
    load()();
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });

  test('preserves unrelated plugin-autosetup hook command', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const unrelatedCmd = 'node "/opt/other-plugin/scripts/plugin-autosetup.js"';
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'sonnet',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: unrelatedCmd }] }]
      }
    }, null, 2));
    load()();
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(unrelatedCmd);
    expect(written.model).toBe('sonnet');
  });

  test('returns error when hooks config contains invalid JSON', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2));

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
