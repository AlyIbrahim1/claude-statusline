const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
  spawnSync: jest.fn()
}));

const CLI_MODULE = '../bin/cli.js';
const SETTINGS_FILE = 'settings.json';

function runCliHistory(args, { resolveBinaryValue = null, spawnStatus = 0 } = {}) {
  jest.resetModules();

  jest.doMock('../scripts/config', () => {
    const actual = jest.requireActual('../scripts/config');
    return {
      ...actual,
      resolveBinary: jest.fn(() => resolveBinaryValue)
    };
  });

  const { spawnSync } = require('child_process');
  spawnSync.mockReturnValue({ status: spawnStatus });

  const originalArgv = process.argv;
  process.argv = [process.execPath, 'bin/cli.js', 'history', ...args];

  const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    const err = new Error('process.exit');
    err.exitCode = code;
    throw err;
  });

  try {
    jest.isolateModules(() => {
      require(CLI_MODULE);
    });
  } catch (err) {
    if (err.message !== 'process.exit') {
      throw err;
    }
  } finally {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  }

  return { spawnSync };
}

describe('cli history mode', () => {
  let tmpDir;
  let originalConfigDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cli-mode-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--mode web writes dashboardMode=web', () => {
    runCliHistory(['--mode', 'web'], { resolveBinaryValue: '/fake/statusline' });

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, SETTINGS_FILE), 'utf8')
    );
    expect(settings.dashboardMode).toBe('web');
  });

  test('--mode terminal writes dashboardMode=terminal', () => {
    runCliHistory(['--mode', 'terminal'], { resolveBinaryValue: '/fake/statusline' });

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, SETTINGS_FILE), 'utf8')
    );
    expect(settings.dashboardMode).toBe('terminal');
  });

  test('no --mode uses existing settings value', () => {
    fs.writeFileSync(
      path.join(tmpDir, SETTINGS_FILE),
      JSON.stringify({ dashboardMode: 'terminal' }, null, 2)
    );

    const { spawnSync } = runCliHistory([], { resolveBinaryValue: '/fake/statusline' });
    expect(spawnSync).toHaveBeenCalledWith('/fake/statusline', ['history', '--terminal'], { stdio: 'inherit' });
  });

  test('no --mode defaults to web when dashboardMode is absent', () => {
    fs.writeFileSync(path.join(tmpDir, SETTINGS_FILE), JSON.stringify({ model: 'sonnet' }, null, 2));

    const { spawnSync } = runCliHistory([], { resolveBinaryValue: '/fake/statusline' });
    expect(spawnSync).toHaveBeenCalledWith('/fake/statusline', ['history'], { stdio: 'inherit' });
  });

  test('terminal mode without binary warns and falls back to web history path', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { spawnSync } = runCliHistory(['--mode', 'terminal'], { resolveBinaryValue: null });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('terminal mode requires the native binary'));

    const scriptPath = path.resolve(__dirname, '../statusline.js');
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [scriptPath, 'history'], { stdio: 'inherit' });
  });
});
