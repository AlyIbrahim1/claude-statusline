Configure claude-statusline as your Claude Code statusline. This writes the `statusLine` command to `~/.claude/settings.json` (replacing any existing one). Session history hooks come with the plugin, so nothing else is needed.

Run the following:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/plugin-autosetup.js" --force
```

After running, restart Claude Code. The statusline appears below your input automatically.

> For the faster Rust binary (~5ms vs ~100ms), also install via npm:
> `npm install -g @alyibrahim/claude-statusline && claude-statusline setup`
