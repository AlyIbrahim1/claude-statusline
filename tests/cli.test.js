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
    expect(r.stdout.toString()).toContain('download-binary');
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
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('hook start');
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toContain('hook end');
  });

  test('disable-history: exits 0 and removes hooks', () => {
    run(['enable-history']);
    const r = run(['disable-history']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('✓');
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toBeUndefined();
  });

  test('realtime-status: prints JSON summary for current tty slug', () => {
    const ttySlug = 'pts-42';
    const statePath = path.join(tmpDir, `statusline-state-${ttySlug}.json`);
    fs.writeFileSync(statePath, JSON.stringify({
      event_type: 'state_update',
      tty_slug: ttySlug,
      updated_at_ms: 123,
    }));

    const r = run(['realtime-status'], { CLAUDE_STATUSLINE_TTY: ttySlug });
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout.toString());
    expect(out.ttySlug).toBe(ttySlug);
    expect(out.hasState).toBe(true);
    expect(out.stateEventType).toBe('state_update');
  });

  test('realtime-stop: succeeds using JS fallback when no native binary', () => {
    const ttySlug = 'pts-88';
    const r = run(['realtime-stop'], {
      CLAUDE_STATUSLINE_REALTIME: '1',
      CLAUDE_STATUSLINE_TTY: ttySlug,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('Realtime shutdown event sent');

    const statePath = path.join(tmpDir, `statusline-state-${ttySlug}.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.event_type).toBe('shutdown');
  });

  test('realtime-status: prints JSON summary with empty state when no files exist', () => {
    const ttySlug = 'pts-00';
    const r = run(['realtime-status'], { CLAUDE_STATUSLINE_TTY: ttySlug });
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout.toString());
    expect(out.ttySlug).toBe(ttySlug);
    expect(out.hasState).toBe(false);
    expect(out.hasRegistry).toBe(false);
    expect(out.stateEventType).toBeNull();
    expect(out.registry).toBeNull();
  });

  test('realtime-status: reflects registry file when it exists', () => {
    const ttySlug = 'pts-11';
    const registryPath = path.join(tmpDir, `statusline-renderer-${ttySlug}.json`);
    fs.writeFileSync(registryPath, JSON.stringify({ heartbeat_at_ms: 999 }));

    const r = run(['realtime-status'], { CLAUDE_STATUSLINE_TTY: ttySlug });
    const out = JSON.parse(r.stdout.toString());
    expect(out.hasRegistry).toBe(true);
    expect(out.registry.heartbeat_at_ms).toBe(999);
  });

  test('realtime-status: ignores malformed state/registry JSON instead of crashing', () => {
    const ttySlug = 'pts-bad';
    fs.writeFileSync(path.join(tmpDir, `statusline-renderer-${ttySlug}.json`), '{ bad');
    fs.writeFileSync(path.join(tmpDir, `statusline-state-${ttySlug}.json`), '{ bad');

    const r = run(['realtime-status'], { CLAUDE_STATUSLINE_TTY: ttySlug });
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout.toString());
    expect(out.ttySlug).toBe(ttySlug);
    expect(out.hasRegistry).toBe(false);
    expect(out.hasState).toBe(false);
    expect(out.stateEventType).toBeNull();
  });

  test('hook: dispatches to JS fallback statusline.js when no binary found', () => {
    // The hook command proxies to statusline.js when no binary is present.
    // Use 'hook start' with a fake marker — statusline.js exits 0 for recognized hook args.
    const r = run(['hook', 'start', '--marker=test-marker']);
    expect(r.status).toBe(0);
  });

  test('history: exits 1 and prints error for unknown option', () => {
    const r = run(['history', '--unknown-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain('Unknown history option');
  });

  test('history: exits 1 when --mode is missing its value', () => {
    const r = run(['history', '--mode']);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain('Missing value for --mode');
  });

  test('history: exits 1 for invalid --mode value', () => {
    const r = run(['history', '--mode', 'invalid']);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain('Invalid mode');
  });
});
