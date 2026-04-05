'use strict';

describe('cli.js download-binary command', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.resetModules();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('dispatches to downloadBinary and prints success output', () => {
    const downloadBinary = jest.fn(() => ({ ok: true, binaryPath: '/tmp/statusline' }));
    jest.doMock('../scripts/download-binary', () => ({ downloadBinary }));

    process.argv = ['node', 'bin/cli.js', 'download-binary'];

    jest.isolateModules(() => {
      require('../bin/cli');
    });

    expect(downloadBinary).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('\n✓ Binary installed at /tmp/statusline');
  });

  test('prints error and exits 1 when downloadBinary fails', () => {
    const downloadBinary = jest.fn(() => ({ ok: false, error: 'boom' }));
    const exitMock = jest.fn(() => {
      throw new Error('EXIT');
    });

    jest.doMock('../scripts/download-binary', () => ({ downloadBinary }));
    process.argv = ['node', 'bin/cli.js', 'download-binary'];
    process.exit = exitMock;

    expect(() => {
      jest.isolateModules(() => {
        require('../bin/cli');
      });
    }).toThrow('EXIT');

    expect(downloadBinary).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Error:', 'boom');
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
