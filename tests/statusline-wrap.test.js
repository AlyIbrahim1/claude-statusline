const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STATUSLINE = path.join(__dirname, '../statusline.js');

function visibleLen(s) {
  const stripped = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  let n = 0;
  for (const ch of stripped) {
    n += ch.codePointAt(0) > 0xFFFF ? 2 : 1;
  }
  return n;
}

function runStatusline(input, env = {}) {
  return spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
  });
}

describe('statusline wrapping', () => {
  test('wraps output so every line fits within COLUMNS when narrow', () => {
    const input = {
      model: { display_name: 'claude-sonnet-4-6-super-long-model-name' },
      workspace: { current_dir: '/tmp/some/very/deep/project/path' },
      session_id: '',
      context_window: {
        remaining_percentage: 42,
        total_input_tokens: 13250,
        total_output_tokens: 2300,
      },
      rate_limits: {
        five_hour: { used_percentage: 71, resets_at: 4102444800 },
        seven_day: { used_percentage: 34 },
      },
    };

    const result = runStatusline(input, { COLUMNS: '24' });
    expect(result.status).toBe(0);

    const out = result.stdout.toString();
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(visibleLen(line)).toBeLessThanOrEqual(24);
    }
  });

  test('does not force extra wrapping when COLUMNS is wide', () => {
    const input = {
      model: { display_name: 'claude-sonnet-4-6' },
      workspace: { current_dir: '/tmp/myproject' },
      session_id: '',
      context_window: {
        remaining_percentage: 90,
        total_input_tokens: 3000,
        total_output_tokens: 500,
      },
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 4102444800 },
        seven_day: { used_percentage: 10 },
      },
    };

    const result = runStatusline(input, { COLUMNS: '200' });
    expect(result.status).toBe(0);

    const out = result.stdout.toString();
    const lines = out.split('\n').filter(Boolean);
    // line1 + separator + line2 in normal wide mode
    expect(lines.length).toBe(3);
  });

  test('writes realtime state snapshot when feature flag is enabled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-rt-wrap-'));
    const input = {
      model: { display_name: 'claude-sonnet-4-6' },
      workspace: { current_dir: '/tmp/myproject' },
      session_id: 'sess-1',
      context_window: { remaining_percentage: 88 },
    };

    const result = runStatusline(input, {
      CLAUDE_STATUSLINE_REALTIME: '1',
      CLAUDE_STATUSLINE_TTY: 'pts/77',
      CLAUDE_CONFIG_DIR: tmp,
    });

    expect(result.status).toBe(0);
    const statePath = path.join(tmp, 'statusline-state-pts-77.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.event_type).toBe('state_update');
    expect(state.tty_slug).toBe('pts-77');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
