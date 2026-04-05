'use strict';

describe('scripts/download-binary.js', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('returns error when npm install fails', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });

    const spawnSync = jest.fn(() => ({ status: 2 }));
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('fs', () => ({ chmodSync: jest.fn() }));

    const { downloadBinary } = require('../scripts/download-binary');
    const result = downloadBinary();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('npm install exited with code 2');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  test('returns installed binary path on success and chmods it on non-win32', () => {
    const spawnSync = jest.fn(() => ({ status: 0 }));
    const chmodSync = jest.fn();
    const resolveBinary = jest.fn(() => '/tmp/statusline');

    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('fs', () => ({ chmodSync }));
    jest.doMock('../scripts/config', () => ({ resolveBinary }));

    const { downloadBinary } = require('../scripts/download-binary');
    const result = downloadBinary();

    expect(result).toEqual({ ok: true, binaryPath: '/tmp/statusline' });
    expect(resolveBinary).toHaveBeenCalledTimes(1);
    if (process.platform !== 'win32') {
      expect(chmodSync).toHaveBeenCalledWith('/tmp/statusline', 0o755);
    }
  });

  test('returns error if install succeeds but binary cannot be resolved', () => {
    const spawnSync = jest.fn(() => ({ status: 0 }));
    const resolveBinary = jest.fn(() => null);

    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('fs', () => ({ chmodSync: jest.fn() }));
    jest.doMock('../scripts/config', () => ({ resolveBinary }));

    const { downloadBinary } = require('../scripts/download-binary');
    const result = downloadBinary();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('binary not found');
  });

  test('uses platform-specific npm executable', () => {
    const spawnSync = jest.fn(() => ({ status: 0 }));
    const resolveBinary = jest.fn(() => '/tmp/statusline');

    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('fs', () => ({ chmodSync: jest.fn() }));
    jest.doMock('../scripts/config', () => ({ resolveBinary }));

    const { downloadBinary } = require('../scripts/download-binary');
    downloadBinary();

    const expectedCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    expect(spawnSync).toHaveBeenCalledWith(
      expectedCmd,
      expect.arrayContaining(['install', '--no-save', expect.stringContaining('@alyibrahim/claude-statusline-')]),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });
});
