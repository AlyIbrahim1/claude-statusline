const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '../bin/cli.js');

describe('cli.js', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cli-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const run = (args, env = {}) => spawnSync(
    process.execPath, [CLI, ...args],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, ...env } }
  );

  test('no args: prints usage and exits 0', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('claude-statusline <command>');
  });

  test('unknown command: prints error and exits 1', () => {
    const r = run(['badcmd']);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain('Unknown command: badcmd');
  });

  test('setup: exits 0 and configures settings.json', () => {
    const r = run(['setup']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('✓');
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')
    );
    expect(settings.statusLine).toBeDefined();
    expect(settings.statusLine.type).toBe('command');
  });

  test('uninstall: exits 0 and removes statusLine', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      model: 'sonnet',
      statusLine: { type: 'command', command: 'node /old.js' }
    }, null, 2));
    const r = run(['uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('✓');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')
    );
    expect(written.statusLine).toBeUndefined();
    expect(written.model).toBe('sonnet');
  });

  test('setup: exits 1 on error (invalid JSON in settings.json)', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ bad }');
    const r = run(['setup']);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain('invalid JSON');
  });

  test('enable-history: exits 0 and adds SessionStart/SessionEnd hooks', () => {
    const r = run(['enable-history']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('✓');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.hooks?.SessionStart?.[0]?.command).toContain('hook start');
    expect(settings.hooks?.SessionEnd?.[0]?.command).toContain('hook end');
  });

  test('disable-history: exits 0 and removes hooks', () => {
    run(['enable-history']);
    const r = run(['disable-history']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('✓');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toBeUndefined();
  });
});
