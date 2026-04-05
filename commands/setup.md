Configure claude-statusline as your Claude Code statusline. This writes the `statusLine` command and session history hooks to `~/.claude/settings.json`.

Run the following:

```bash
node -e "
const os = require('os'), fs = require('fs'), path = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
if (!pluginRoot) {
  console.error('Plugin root not found. Install via npm for full setup:');
  console.error('  npm install -g @alyibrahim/claude-statusline && claude-statusline setup');
  process.exit(1);
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(configDir, 'settings.json');

// Resolve the binary or JS fallback — same logic as config.js resolveBinary()
let command = null;
const platformKey = process.platform + '-' + process.arch;
const pkgName = '@alyibrahim/claude-statusline-' + platformKey;
const binName = process.platform === 'win32' ? 'statusline.exe' : 'statusline';
try {
  const pkgJson = require.resolve(pkgName + '/package.json');
  const bin = path.join(path.dirname(pkgJson), binName);
  if (fs.existsSync(bin)) command = '\"' + bin + '\"';
} catch (e) {}

if (!command) {
  const script = path.join(pluginRoot, 'statusline.js');
  if (!fs.existsSync(script)) { console.error('statusline.js not found at', script); process.exit(1); }
  command = '\"' + process.execPath + '\" \"' + script + '\"';
}

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) {}

settings.statusLine = { type: 'command', command };

// Merge hooks from hooks/hooks.json, substituting \${CLAUDE_PLUGIN_ROOT}
const hooksConfig = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')
);
const resolvedHooks = JSON.parse(
  JSON.stringify(hooksConfig.hooks).replace(/\\\${CLAUDE_PLUGIN_ROOT}/g, pluginRoot.replace(/\\\\/g, '\\\\\\\\'))
);
if (!settings.hooks) settings.hooks = {};
for (const [event, entries] of Object.entries(resolvedHooks)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  settings.hooks[event] = settings.hooks[event].filter(h =>
    !(h.hooks||[]).some(i => (i.command||'').includes('statusline'))
  );
  settings.hooks[event].push(...entries);
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const tmp = settingsPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
fs.renameSync(tmp, settingsPath);
console.log('claude-statusline configured.');
console.log('Command:', command);
console.log('Restart Claude Code to see the statusline.');
"
```

After running, restart Claude Code. The statusline appears below your input automatically.

> For the faster Rust binary (~5ms vs ~100ms), also install via npm:
> `npm install -g @alyibrahim/claude-statusline && claude-statusline setup`
