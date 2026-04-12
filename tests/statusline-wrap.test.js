const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { normalizeProjectSlug } = require('../scripts/slug-utils');

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

function runStatuslineRaw(input, env = {}) {
  return spawnSync(process.execPath, [STATUSLINE], {
    input,
    env: { ...process.env, ...env },
  });
}

function writeProjectSessionJsonl(claudeDir, absDir, session, text) {
  const projectDir = path.join(claudeDir, 'projects', normalizeProjectSlug(absDir));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), text);
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

  test('exits cleanly on malformed stdin JSON', () => {
    const result = runStatuslineRaw('{"model":');
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe('');
  });

  test('recovers from malformed token cache and ignores malformed/incomplete JSONL lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wrap-cache-'));
    const absDir = path.join(tmp, 'workspace', 'project');
    const session = 'sess-wrap-1';
    fs.mkdirSync(absDir, { recursive: true });

    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 5 } },
      }),
      '{bad json line',
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 1,
          },
        },
      }),
      // Last line intentionally has no trailing newline; parser should skip it as incomplete.
      '{"type":"assistant","message":{"usage":{"input_tokens":999,"output_tokens":999}}}',
    ].join('\n');

    writeProjectSessionJsonl(tmp, absDir, session, jsonl);
    fs.writeFileSync(path.join(tmp, `statusline-tokcache-${session}.json`), '{not valid json');

    const input = JSON.stringify({
      model: { display_name: 'M' },
      workspace: { current_dir: absDir },
      session_id: session,
      context_window: { remaining_percentage: 90, total_input_tokens: 0, total_output_tokens: 0 },
    });

    const result = runStatuslineRaw(input, { CLAUDE_CONFIG_DIR: tmp });
    expect(result.status).toBe(0);

    const out = result.stdout.toString();
    expect(out).toContain('19');
    expect(out).toContain('8');
    expect(out).toContain('↓');
    expect(out).toContain('↑');

    const cache = JSON.parse(fs.readFileSync(path.join(tmp, `statusline-tokcache-${session}.json`), 'utf8'));
    expect(cache.totalIn).toBe(19);
    expect(cache.totalOut).toBe(8);
    expect(cache.offset).toBeGreaterThan(0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('uses byte-offset cache across renders and accumulates totals from appended lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wrap-offset-'));
    const absDir = path.join(tmp, 'workspace', 'project');
    const session = 'sess-wrap-2';
    fs.mkdirSync(absDir, { recursive: true });

    const line1 = `${JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 100, output_tokens: 50 } },
    })}\n`;

    writeProjectSessionJsonl(tmp, absDir, session, line1);

    const input = JSON.stringify({
      model: { display_name: 'M' },
      workspace: { current_dir: absDir },
      session_id: session,
      context_window: { remaining_percentage: 85, total_input_tokens: 0, total_output_tokens: 0 },
    });

    const r1 = runStatuslineRaw(input, { CLAUDE_CONFIG_DIR: tmp });
    expect(r1.status).toBe(0);
    expect(r1.stdout.toString()).toContain('100');
    expect(r1.stdout.toString()).toContain('50');

    const projectFile = path.join(tmp, 'projects', normalizeProjectSlug(absDir), `${session}.jsonl`);
    fs.appendFileSync(projectFile, `${JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 20, output_tokens: 10 } },
    })}\n`);

    const r2 = runStatuslineRaw(input, { CLAUDE_CONFIG_DIR: tmp });
    expect(r2.status).toBe(0);
    expect(r2.stdout.toString()).toContain('120');
    expect(r2.stdout.toString()).toContain('60');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('renders successfully when COLUMNS is zero or negative', () => {
    const input = {
      model: { display_name: 'M' },
      workspace: { current_dir: '/tmp/myproject' },
      session_id: '',
      context_window: { remaining_percentage: 90 },
    };

    for (const columns of ['0', '-5']) {
      const result = runStatusline(input, { COLUMNS: columns });
      expect(result.status).toBe(0);
      expect(result.stdout.toString().length).toBeGreaterThan(0);
    }
  });
});
