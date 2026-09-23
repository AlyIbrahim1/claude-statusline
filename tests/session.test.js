const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { statePath, load, save, gitInfo } = require('../scripts/session');

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args,
], { cwd, stdio: 'ignore' });

describe('session state', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-session-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('statePath rejects unsafe session ids', () => {
    expect(statePath('/c', '')).toBeNull();
    expect(statePath('/c', '../etc')).toBeNull();
    expect(statePath('/c', 'a/b')).toBeNull();
    expect(statePath('/c', 'abc-1_x')).toBe(path.join('/c', 'statusline', 'sessions', 'abc-1_x.json'));
  });

  test('save/load round trip and garbage falls back to empty state', () => {
    const file = path.join(tmp, 'statusline', 'sessions', 's.json');
    save(file, { files: {}, tin: 1, tcache: 2, tout: 3, git: {} });
    expect(load(file).tout).toBe(3);
    fs.writeFileSync(file, '[1,2]');
    expect(load(file)).toEqual({ files: {}, tin: 0, tcache: 0, tout: 0, git: {} });
  });

  test('gitInfo reads branch, counts session commits, handles packed refs and detached HEAD', () => {
    git(tmp, 'init', '-q', '-b', 'trunk');
    git(tmp, 'commit', '-q', '--allow-empty', '-m', 'one');
    const sub = path.join(tmp, 'src');
    fs.mkdirSync(sub);
    const state = load(null);

    expect(gitInfo(sub, state)).toEqual({ branch: 'trunk', commits: 0 });
    git(tmp, 'commit', '-q', '--allow-empty', '-m', 'two');
    git(tmp, 'commit', '-q', '--allow-empty', '-m', 'three');
    expect(gitInfo(sub, state)).toEqual({ branch: 'trunk', commits: 2 });

    git(tmp, 'pack-refs', '--all');
    expect(gitInfo(tmp, state)).toEqual({ branch: 'trunk', commits: 2 });

    git(tmp, 'checkout', '-q', '--detach');
    expect(gitInfo(tmp, state).branch).toHaveLength(7);
  });

  test('gitInfo follows a linked worktree and tolerates an unborn branch', () => {
    const main = path.join(tmp, 'main');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'trunk');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'one');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', '../wt');
    expect(gitInfo(path.join(tmp, 'wt'), load(null)).branch).toBe('feat');

    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'new');
    const state = load(null);
    expect(gitInfo(fresh, state)).toEqual({ branch: 'new', commits: 0 });
    expect(state.git).toEqual({});
  });

  test('gitInfo returns empty outside a repo', () => {
    expect(gitInfo(tmp, load(null))).toEqual({ branch: '', commits: 0 });
  });
});
