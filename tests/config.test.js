const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSettingsPath, atomicWrite, getRealtimeTtySlug, getRealtimePaths } = require('../scripts/config');

describe('getSettingsPath', () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  test('returns ~/.claude/settings.json when CLAUDE_CONFIG_DIR is unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(getSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });

  test('uses CLAUDE_CONFIG_DIR when set and non-empty', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/dir';
    expect(getSettingsPath()).toBe('/custom/dir/settings.json');
  });

  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty string', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(getSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });

  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is whitespace only', () => {
    process.env.CLAUDE_CONFIG_DIR = '   ';
    expect(getSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });
});

describe('atomicWrite', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes JSON with 2-space indent', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    atomicWrite(filePath, { foo: 'bar' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(JSON.stringify({ foo: 'bar' }, null, 2));
  });

  test('overwrites existing file', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, '{"old":"data"}');
    atomicWrite(filePath, { new: 'data' });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ new: 'data' });
  });

  test('deletes stale .tmp before writing', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath + '.tmp', 'stale');
    atomicWrite(filePath, { clean: true });
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ clean: true });
  });

  test('leaves no .tmp file on success', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    atomicWrite(filePath, { x: 1 });
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });
});

describe('getRealtimeTtySlug', () => {
  const originalTty = process.env.CLAUDE_STATUSLINE_TTY;
  const originalTermSession = process.env.TERM_SESSION_ID;

  afterEach(() => {
    if (originalTty === undefined) delete process.env.CLAUDE_STATUSLINE_TTY;
    else process.env.CLAUDE_STATUSLINE_TTY = originalTty;

    if (originalTermSession === undefined) delete process.env.TERM_SESSION_ID;
    else process.env.TERM_SESSION_ID = originalTermSession;
  });

  test('uses sanitized CLAUDE_STATUSLINE_TTY when available', () => {
    process.env.CLAUDE_STATUSLINE_TTY = 'pts/77@host';
    expect(getRealtimeTtySlug()).toBe('pts-77-host');
  });

  test('falls back to TERM_SESSION_ID when CLAUDE_STATUSLINE_TTY sanitizes empty', () => {
    process.env.CLAUDE_STATUSLINE_TTY = '///';
    process.env.TERM_SESSION_ID = 'term#1';
    expect(getRealtimeTtySlug()).toBe('term-1');
  });

  test('falls back to pid slug when env sources sanitize empty', () => {
    process.env.CLAUDE_STATUSLINE_TTY = '///';
    process.env.TERM_SESSION_ID = '***';
    expect(getRealtimeTtySlug()).toBe(`pid-${process.pid}`);
  });
});

describe('getRealtimePaths', () => {
  const originalTty = process.env.CLAUDE_STATUSLINE_TTY;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalTty === undefined) delete process.env.CLAUDE_STATUSLINE_TTY;
    else process.env.CLAUDE_STATUSLINE_TTY = originalTty;
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });

  test('returns paths derived from CLAUDE_CONFIG_DIR and tty slug', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    process.env.CLAUDE_STATUSLINE_TTY = 'pts-42';
    const p = getRealtimePaths();
    expect(p.claudeDir).toBe('/tmp/cfg');
    expect(p.ttySlug).toBe('pts-42');
    expect(p.registryPath).toBe('/tmp/cfg/statusline-renderer-pts-42.json');
    expect(p.statePath).toBe('/tmp/cfg/statusline-state-pts-42.json');
    expect(p.socketPath).toBe('/tmp/cfg/statusline-rt-pts-42.sock');
  });

  test('all paths are under the same claudeDir', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    process.env.CLAUDE_STATUSLINE_TTY = 'test-tty';
    const p = getRealtimePaths();
    for (const key of ['registryPath', 'statePath', 'socketPath']) {
      expect(p[key].startsWith(p.claudeDir)).toBe(true);
    }
  });

  test('different tty slugs produce distinct paths', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    process.env.CLAUDE_STATUSLINE_TTY = 'pts-1';
    const p1 = getRealtimePaths();
    process.env.CLAUDE_STATUSLINE_TTY = 'pts-2';
    const p2 = getRealtimePaths();
    expect(p1.statePath).not.toBe(p2.statePath);
    expect(p1.socketPath).not.toBe(p2.socketPath);
  });

  test('falls back to pid-based slug when tty env sanitizes empty', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    process.env.CLAUDE_STATUSLINE_TTY = '///';
    delete process.env.TERM_SESSION_ID;
    const p = getRealtimePaths();
    expect(p.ttySlug).toBe(`pid-${process.pid}`);
    expect(p.statePath).toContain(`statusline-state-pid-${process.pid}.json`);
  });
});
