const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POSTINSTALL = path.join(__dirname, '../scripts/postinstall.js');
const PREUNINSTALL = path.join(__dirname, '../scripts/preuninstall.js');

const FILES = ['history.md', 'history-enable.md', 'history-disable.md', 'history-mode.md'];

describe('slash command lifecycle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-slash-'));
    delete require.cache[require.resolve('../scripts/postinstall')];
    delete require.cache[require.resolve('../scripts/preuninstall')];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScript(scriptPath, envOverrides = {}) {
    return spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, ...envOverrides }
    });
  }

  test('postinstall copies slash command files on global install', () => {
    const result = runScript(POSTINSTALL, { npm_config_global: 'true' });
    const commandsDir = path.join(tmpDir, 'commands');

    expect(result.status).toBe(0);
    for (const f of FILES) {
      expect(fs.existsSync(path.join(commandsDir, f))).toBe(true);
    }
  });

  test('postinstall creates commands directory if missing', () => {
    const commandsDir = path.join(tmpDir, 'commands');
    expect(fs.existsSync(commandsDir)).toBe(false);

    const result = runScript(POSTINSTALL, { npm_config_global: 'true' });

    expect(result.status).toBe(0);
    expect(fs.existsSync(commandsDir)).toBe(true);
    expect(fs.statSync(commandsDir).isDirectory()).toBe(true);
  });

  test('postinstall skips when CI=true and install is not global', () => {
    const result = runScript(POSTINSTALL, { CI: 'true', npm_config_global: 'false' });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'commands'))).toBe(false);
  });

  test('postinstall skips on local install', () => {
    const result = runScript(POSTINSTALL, { npm_config_global: 'false' });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'commands'))).toBe(false);
  });

  test('preuninstall removes installed slash command files', () => {
    const installResult = runScript(POSTINSTALL, { npm_config_global: 'true' });
    expect(installResult.status).toBe(0);

    const uninstallResult = runScript(PREUNINSTALL);
    const commandsDir = path.join(tmpDir, 'commands');

    expect(uninstallResult.status).toBe(0);
    for (const f of FILES) {
      expect(fs.existsSync(path.join(commandsDir, f))).toBe(false);
    }
  });

  test('preuninstall leaves other files untouched', () => {
    const installResult = runScript(POSTINSTALL, { npm_config_global: 'true' });
    expect(installResult.status).toBe(0);

    const commandsDir = path.join(tmpDir, 'commands');
    const customFile = path.join(commandsDir, 'custom.md');
    fs.writeFileSync(customFile, '!echo custom\n');

    const uninstallResult = runScript(PREUNINSTALL);

    expect(uninstallResult.status).toBe(0);
    expect(fs.existsSync(customFile)).toBe(true);
  });

  test('preuninstall is a no-op when slash command files are missing', () => {
    const uninstallResult = runScript(PREUNINSTALL);

    expect(uninstallResult.status).toBe(0);
    expect(uninstallResult.stdout.toString()).toBe('');
    expect(uninstallResult.stderr.toString()).toBe('');
  });
});
