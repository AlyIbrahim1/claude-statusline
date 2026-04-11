const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUSLINE = path.join(__dirname, '../statusline.js');

function runStatuslineWithInput(input, env = {}) {
  return spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
  });
}

describe('realtime producer snapshots', () => {
  test('does not write realtime state when feature flag is disabled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-rt-off-'));
    const tty = 'pts-501';

    const input = {
      model: { display_name: 'M' },
      workspace: { current_dir: '/tmp/myproject' },
      context_window: { remaining_percentage: 90 },
    };

    const r = runStatuslineWithInput(input, {
      CLAUDE_CONFIG_DIR: tmp,
      CLAUDE_STATUSLINE_TTY: tty,
      CLAUDE_STATUSLINE_REALTIME: '0',
    });

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, `statusline-state-${tty}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmp, `statusline-renderer-${tty}.json`))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writes lifecycle snapshot on JS realtime shutdown command', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-rt-shutdown-'));
    const tty = 'pts-701';

    const r = spawnSync(process.execPath, [STATUSLINE, 'realtime', 'shutdown'], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: tmp,
        CLAUDE_STATUSLINE_TTY: tty,
        CLAUDE_STATUSLINE_REALTIME: '1',
      },
    });

    expect(r.status).toBe(0);
    const statePath = path.join(tmp, `statusline-state-${tty}.json`);
    expect(fs.existsSync(statePath)).toBe(true);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.event_type).toBe('shutdown');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('isolates state snapshots across tty slugs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-rt-isolation-'));

    const input = {
      model: { display_name: 'M' },
      workspace: { current_dir: '/tmp/myproject' },
      context_window: { remaining_percentage: 90 },
    };

    const r1 = runStatuslineWithInput(input, {
      CLAUDE_CONFIG_DIR: tmp,
      CLAUDE_STATUSLINE_TTY: 'pts-801',
      CLAUDE_STATUSLINE_REALTIME: '1',
    });
    const r2 = runStatuslineWithInput(input, {
      CLAUDE_CONFIG_DIR: tmp,
      CLAUDE_STATUSLINE_TTY: 'pts-802',
      CLAUDE_STATUSLINE_REALTIME: '1',
    });

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'statusline-state-pts-801.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'statusline-state-pts-802.json'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('recovery rewrites stale registry heartbeat on new state update', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-rt-recovery-'));
    const tty = 'pts-901';
    const registryPath = path.join(tmp, `statusline-renderer-${tty}.json`);

    fs.writeFileSync(registryPath, JSON.stringify({ heartbeat_at_ms: 1 }));

    const input = {
      model: { display_name: 'M' },
      workspace: { current_dir: '/tmp/myproject' },
      context_window: { remaining_percentage: 90 },
    };

    const r = runStatuslineWithInput(input, {
      CLAUDE_CONFIG_DIR: tmp,
      CLAUDE_STATUSLINE_TTY: tty,
      CLAUDE_STATUSLINE_REALTIME: '1',
    });

    expect(r.status).toBe(0);
    const updated = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(updated.heartbeat_at_ms).toBeGreaterThan(1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
