const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const history = require('../scripts/history');
const session = require('../scripts/session');

const STATUSLINE = path.join(__dirname, '../statusline.js');

const state = (tin, tout, extra = {}) => ({
  ...session.load(null), tin, tout, start: 1700000000, dur: 90, model: 'Opus 5.5', project: 'proj', cost: 1.23456, ...extra,
});

describe('history store', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-history-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('record line is compact, round-trips, and matches the Rust format', () => {
    const line = history.recordLine('3f9a2c1b-aaaa-bbbb', state(100, 50), 'clear', 0);
    expect(line).toBe('h(["3f9a2c1b","proj","Opus 5.5",1700000000,90,100,0,50,1.2346,"clear"]);\n');
    const rec = history.parseLine(line);
    expect(rec).toMatchObject({ id: '3f9a2c1b', tokens_in: 100, tokens_out: 50, start_time: '2023-11-14 22:13:20' });
  });

  test('hostile project names stay inside the JSON string', () => {
    const project = '");alert(1);//</script>';
    expect(history.parseLine(history.recordLine('x', state(1, 1, { project }), 'other', 0)).project_name).toBe(project);
  });

  test('sessions without tokens are not recorded', () => {
    expect(history.recordLine('x', session.load(null), 'clear', 5)).toBe('');
  });

  test('readHistory keeps the last line per id and sorts newest first', () => {
    const file = path.join(tmp, 'history.js');
    fs.writeFileSync(file, [
      history.recordLine('aaaaaaaa', state(1, 1, { start: 100 }), 'resume', 0),
      'garbage line\n',
      history.recordLine('bbbbbbbb', state(2, 2, { start: 200 }), 'clear', 0),
      history.recordLine('aaaaaaaa', state(5, 5, { start: 100 }), 'prompt_input_exit', 0),
    ].join(''));
    const recs = history.readHistory(file);
    expect(recs.map(r => r.id)).toEqual(['bbbbbbbb', 'aaaaaaaa']);
    expect(recs[1]).toMatchObject({ tokens_in: 5, exit_reason: 'prompt_input_exit' });
    expect(history.readHistory(path.join(tmp, 'missing.js'))).toEqual([]);
  });

  test('sweepStale finalizes only state files older than a day', () => {
    const fresh = session.statePath(tmp, 'fresh');
    const stale = session.statePath(tmp, 'stale');
    session.save(fresh, state(1, 1));
    session.save(stale, state(2, 2));
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(stale, old, old);

    history.sweepStale(tmp, session.nowSecs());
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(history.readHistory(history.historyPath(tmp))).toMatchObject([{ id: 'stale', exit_reason: 'other' }]);
  });

  test('migrateLegacy converts old history and deletes loose files', () => {
    const home = path.join(tmp, 'home-claude');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'statusline-history.jsonl'), [
      JSON.stringify({ session_id: '11111111-x', project_name: 'p', model: 'm', start_time: '2026-01-01 00:00:00', duration_seconds: 5, tokens_in: 9, tokens_out: 4, cost_usd: 0, exit_reason: 'clear' }),
      JSON.stringify({ session_id: 'pending-p-1', project_name: 'p', exit_reason: 'pending' }),
      'not json',
    ].join('\n'));
    for (const f of ['statusline-tokcache-a.json', 'statusline-session-a.json', 'statusline-renderer-t.json', 'settings.json']) {
      fs.writeFileSync(path.join(tmp, f), '{}');
    }

    history.migrateLegacy(tmp, home);
    const recs = history.readHistory(history.historyPath(tmp));
    expect(recs).toMatchObject([{ id: '', tokens_in: 9, start_time: '2026-01-01 00:00:00' }]);
    expect(fs.existsSync(path.join(home, 'statusline-history.jsonl'))).toBe(false);
    expect(fs.readdirSync(tmp).sort()).toEqual(['home-claude', 'settings.json', 'statusline']);
  });

  test('SessionEnd hook appends a record from the render state and deletes the state file', () => {
    const transcript = path.join(tmp, 'sess-e2e.jsonl');
    const usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 };
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage } })}\n`);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp, HOME: tmp };

    spawnSync(process.execPath, [STATUSLINE], { env, input: JSON.stringify({
      model: { display_name: 'Opus 5.5' }, session_id: 'sess-e2e', transcript_path: transcript,
      workspace: { current_dir: tmp, project_dir: path.join(tmp, 'my-proj') },
      cost: { total_cost_usd: 0.5, total_duration_ms: 61000 },
    }) });
    const stateFile = session.statePath(tmp, 'sess-e2e');
    expect(fs.existsSync(stateFile)).toBe(true);

    // A turn lands after the last render; the hook catches it up.
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
    const r = spawnSync(process.execPath, [STATUSLINE, 'hook', 'end'], { env, input: JSON.stringify({
      session_id: 'sess-e2e', transcript_path: transcript, reason: 'prompt_input_exit',
    }) });
    expect(r.status).toBe(0);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(history.readHistory(history.historyPath(tmp))).toMatchObject([{
      id: 'sess-e2e', project_name: 'my-proj', model: 'Opus 5.5', duration_seconds: 61,
      tokens_in: 11, tokens_cache: 100, tokens_out: 5, cost_usd: 0.5, exit_reason: 'prompt_input_exit',
    }]);
  });

  test('hook start is a silent no-op for hooks written by older versions', () => {
    const r = spawnSync(process.execPath, [STATUSLINE, 'hook', 'start'], { env: { ...process.env, CLAUDE_CONFIG_DIR: tmp } });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test('uninstall removes the data folder only when asked', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmp;
    const { uninstall } = require('../scripts/uninstall');
    fs.mkdirSync(path.join(tmp, 'statusline', 'sessions'), { recursive: true });
    uninstall();
    expect(fs.existsSync(path.join(tmp, 'statusline'))).toBe(true);
    uninstall({ removeData: true });
    expect(fs.existsSync(path.join(tmp, 'statusline'))).toBe(false);
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  });

  test('installDashboard copies the single page once and repairs a changed copy', () => {
    const source = fs.readFileSync(path.join(__dirname, '../dashboard-design/dashboard.html'), 'utf8');
    const page = history.installDashboard(tmp);
    expect(page).toBe(path.join(tmp, 'statusline', 'dashboard.html'));
    expect(fs.readFileSync(page, 'utf8')).toBe(source);
    fs.writeFileSync(page, 'stale');
    history.installDashboard(tmp);
    expect(fs.readFileSync(page, 'utf8')).toBe(source);
    expect(source).not.toMatch(/googleapis|innerHTML/);
  });
});
