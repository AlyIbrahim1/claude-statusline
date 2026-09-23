#!/usr/bin/env node
'use strict';
// Installs the packed npm package the way users do (npm install -g) into a throwaway prefix and
// config dir, then drives it through Claude Code's real entry points: the statusLine command,
// the SessionEnd hook, and `claude-statusline uninstall`. Exits non-zero on the first failure.
//
//   --local-binary <path>  put this freshly built binary into the platform package (CI: the
//                          platform package for an unreleased version is not on npm yet)
//   --expect-binary        require npm to have installed the native binary (release, after the
//                          platform packages are published)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const localBinary = args.includes('--local-binary') ? path.resolve(args[args.indexOf('--local-binary') + 1]) : null;
const expectBinary = args.includes('--expect-binary') || Boolean(localBinary);
const win = process.platform === 'win32';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-smoke-'));
const prefix = path.join(tmp, 'prefix');
const configDir = path.join(tmp, 'claude');
const home = path.join(tmp, 'home');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, HOME: home, USERPROFILE: home };

function check(ok, message, detail) {
  if (ok) { console.log(`ok   ${message}`); return; }
  console.error(`FAIL ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  // npm is npm.cmd on Windows and needs a shell; node does not, and cmd.exe would mangle `node -e` quoting.
  const r = spawnSync(cmd, cmdArgs, { env, encoding: 'utf8', shell: win && cmd === 'npm', ...opts });
  if (r.status !== 0) check(false, `${cmd} ${cmdArgs.join(' ')} exited ${r.status}`, `${r.stdout}\n${r.stderr}`);
  return r;
}

// A settings command is a shell string, exactly as Claude Code runs it.
function runCommand(command, input) {
  return spawnSync(command, { env, input, encoding: 'utf8', shell: true, cwd: tmp });
}

const settings = () => JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));

// 1. Pack and install globally. Pre-existing settings must survive.
fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
  theme: 'dark',
  hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] },
}));
const packed = run('npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: repo }).stdout.trim().split('\n').pop();
run('npm', ['install', '-g', '--prefix', prefix, path.join(tmp, packed)]);
const pkgRoot = path.join(run('npm', ['root', '-g', '--prefix', prefix]).stdout.trim(), '@alyibrahim', 'claude-statusline');
check(fs.existsSync(path.join(pkgRoot, 'dashboard-design', 'dashboard.html')), 'package ships dashboard.html');

const platformPkg = `claude-statusline-${process.platform}-${process.arch}`;
if (localBinary) {
  const dir = path.join(pkgRoot, 'node_modules', '@alyibrahim', platformPkg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@alyibrahim/${platformPkg}`, version: '0.0.0' }));
  fs.copyFileSync(localBinary, path.join(dir, win ? 'statusline.exe' : 'statusline'));
  fs.chmodSync(path.join(dir, win ? 'statusline.exe' : 'statusline'), 0o755);
}
// Global postinstall already configured settings; setup again picks up a local binary.
run(process.execPath, [path.join(pkgRoot, 'bin', 'cli.js'), 'setup']);

// 2. Settings: statusLine, exactly one SessionEnd hook, user keys kept, slash commands copied.
const s = settings();
check(s.theme === 'dark' && s.hooks.PreToolUse.length === 1, 'existing settings and hooks preserved', s);
check(s.statusLine && s.statusLine.type === 'command', 'statusLine configured', s);
check(s.hooks.SessionEnd && s.hooks.SessionEnd.length === 1 && !s.hooks.SessionStart, 'exactly one SessionEnd hook', s.hooks);
if (expectBinary) check(s.statusLine.command.includes(platformPkg), 'statusLine uses the native binary', s.statusLine.command);
const commands = path.join(configDir, 'commands');
check(fs.existsSync(path.join(commands, 'history.md')), 'slash commands installed');

// 3-4. For the configured command and the JS fallback: render, then SessionEnd through the same
//      command. One history line, state removed. A second SessionEnd firing (plugin and npm both
//      installed) must not add another line.
const transcript = path.join(home, 'sess.jsonl');
const usage = { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 50000, output_tokens: 800 };
const entry = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', usage } });
fs.writeFileSync(transcript, `${entry}\n${entry}\n`); // the duplicate must be counted once
const historyFile = path.join(configDir, 'statusline', 'history.js');
const impls = [['configured command', s.statusLine.command, s.hooks.SessionEnd[0].hooks[0].command],
  ['JS fallback', `"${process.execPath}" "${path.join(pkgRoot, 'statusline.js')}"`]];
impls[1].push(`${impls[1][1]} hook end`);
impls.forEach(([label, command, hook], i) => {
  const id = `smoke-${i}`;
  const r = runCommand(command, JSON.stringify({
    session_id: id, transcript_path: transcript,
    model: { display_name: 'SmokeModel' }, workspace: { current_dir: tmp, project_dir: tmp },
    effort: { level: 'high' }, cost: { total_cost_usd: 0.5, total_duration_ms: 60000 },
  }));
  check(r.status === 0 && r.stdout.includes('SmokeModel') && r.stdout.includes('1.5k') && r.stdout.includes('50.0k cache'),
    `${label}: render`, `${r.status}\n${r.stdout}\n${r.stderr}`);
  const stateFile = path.join(configDir, 'statusline', 'sessions', `${id}.json`);
  check(fs.existsSync(stateFile), `${label}: session state written`);
  for (let n = 1; n <= 2; n++) {
    const h = runCommand(hook, JSON.stringify({ session_id: id, transcript_path: transcript, reason: 'prompt_input_exit' }));
    check(h.status === 0, `${label}: SessionEnd run ${n}`, `${h.stdout}\n${h.stderr}`);
  }
  const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(l => l.startsWith(`h(["${id}"`));
  check(lines.length === 1 && lines[0].endsWith(',1500,50000,800,0.5,"prompt_input_exit",""]);'),
    `${label}: history line recorded once`, lines);
  check(!fs.existsSync(stateFile), `${label}: session state removed`);
});

// 5. Dashboard page installs next to history.js without opening a browser.
run(process.execPath, ['-e', `require(${JSON.stringify(path.join(pkgRoot, 'scripts', 'history.js'))}).installDashboard(process.env.CLAUDE_CONFIG_DIR)`]);
check(fs.existsSync(path.join(configDir, 'statusline', 'dashboard.html')), 'dashboard installed');

// 6. Uninstall removes everything of ours and nothing else.
run(process.execPath, [path.join(pkgRoot, 'bin', 'cli.js'), 'uninstall']);
const after = settings();
check(!after.statusLine && !after.hooks.SessionEnd && after.hooks.PreToolUse.length === 1 && after.theme === 'dark',
  'uninstall cleans settings and keeps the rest', after);
check(!fs.existsSync(path.join(configDir, 'statusline')), 'uninstall removes the data folder');
check(!fs.existsSync(path.join(commands, 'history.md')), 'uninstall removes slash commands');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('smoke install passed');
