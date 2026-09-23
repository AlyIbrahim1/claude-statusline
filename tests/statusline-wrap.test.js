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

function runStatuslineRaw(input, env = {}) {
  return spawnSync(process.execPath, [STATUSLINE], {
    input,
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

  test('exits cleanly on malformed stdin JSON', () => {
    const result = runStatuslineRaw('{"model":');
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe('');
  });

  test('reads transcript_path, dedupes repeated usage, skips malformed/incomplete lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wrap-tokens-'));
    const transcript = path.join(tmp, 'sess-wrap-1.jsonl');
    const usage = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1 };
    const line = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', usage } });
    fs.writeFileSync(transcript, [
      line,
      line, // same message repeated for the next content block
      '{bad json line "usage" "assistant"',
      // No trailing newline: incomplete, must be skipped.
      '{"type":"assistant","message":{"id":"m9","usage":{"input_tokens":999,"output_tokens":999}}}',
    ].join('\n'));
    fs.mkdirSync(path.join(tmp, 'statusline', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'statusline', 'sessions', 'sess-wrap-1.json'), '{not valid json');

    const result = runStatusline({
      model: { display_name: 'M' },
      session_id: 'sess-wrap-1',
      transcript_path: transcript,
      context_window: { remaining_percentage: 90, total_input_tokens: 5000, total_output_tokens: 5000 },
    }, { CLAUDE_CONFIG_DIR: tmp, COLUMNS: '200' });
    expect(result.status).toBe(0);

    const out = result.stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');
    expect(out).toContain('8↓ + 2.0k cache 3↑');

    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'statusline', 'sessions', 'sess-wrap-1.json'), 'utf8'));
    expect([state.tin, state.tcache, state.tout]).toEqual([8, 2000, 3]);
    expect(Object.keys(state.files)).toEqual([transcript]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('state cursor makes renders incremental and counts subagent transcripts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wrap-offset-'));
    const transcript = path.join(tmp, 'sess-wrap-2.jsonl');
    const entry = (id, i, o) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: i, output_tokens: o } } })}\n`;
    fs.writeFileSync(transcript, entry('m1', 100, 50));
    const input = {
      model: { display_name: 'M' },
      session_id: 'sess-wrap-2',
      transcript_path: transcript,
    };
    const plain = r => r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');

    expect(plain(runStatusline(input, { CLAUDE_CONFIG_DIR: tmp }))).toContain('100↓ 50↑');

    fs.appendFileSync(transcript, entry('m2', 20, 10));
    const subs = path.join(tmp, 'sess-wrap-2', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(path.join(subs, 'agent-x.jsonl'), entry('m3', 5, 5));
    expect(plain(runStatusline(input, { CLAUDE_CONFIG_DIR: tmp }))).toContain('125↓ 65↑');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('shows effort from stdin and hides it when absent', () => {
    const plain = r => r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');
    const base = { model: { display_name: 'M' }, session_id: '' };
    expect(plain(runStatusline({ ...base, effort: { level: 'xhigh' } }))).toContain('M [XH]');
    expect(plain(runStatusline(base))).not.toContain('[');
  });

  test('labels directories outside home without a tilde', () => {
    const plain = r => r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wrap-dir-'));
    const dir = path.join(tmp, 'parent', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const out = plain(runStatusline(
      { model: { display_name: 'M' }, session_id: '', workspace: { current_dir: dir } },
      { HOME: path.join(tmp, 'home') },
    ));
    expect(out).toContain('parent/proj');
    expect(out).not.toContain('~/');
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
