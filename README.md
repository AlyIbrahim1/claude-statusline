# claude-statusline

[![CI](https://github.com/AlyIbrahim1/claude-statusline/actions/workflows/ci.yml/badge.svg)](https://github.com/AlyIbrahim1/claude-statusline/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@alyibrahim/claude-statusline)](https://www.npmjs.com/package/@alyibrahim/claude-statusline)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A rich, fast statusline for [Claude Code](https://claude.ai/code)** — shows model, git branch, context usage, rate limits, and session cost after every response.

Runs as a **compiled Rust binary** (~5ms startup vs ~100ms for Node.js). Zero shell dependencies. One install command.

![statusline screenshot](https://raw.githubusercontent.com/AlyIbrahim1/claude-statusline/main/.github/image.png)

---

## Install

```bash
npm install -g @alyibrahim/claude-statusline
```

Done. The statusline configures itself automatically. Restart Claude Code to see it.

> If auto-setup didn't run: `claude-statusline setup`

---

## What you get

**Line 1** — Model name · Effort level · Active subagents · Current task · Directory `[branch]` · Context bar

**Line 2** — Weekly token usage · 5h usage · Reset countdown *(Pro/Max)* — or — Session cost *(API key)*

| Feature | Details |
|---|---|
| Context bar | Normalized to usable % — accounts for the auto-compact buffer |
| Rate limits | Shows 5h and weekly usage with color-coded thresholds |
| Session cost | Displayed only for API key users, hidden for subscribers |
| Active agents | Counts running subagents from your `~/.claude/todos/` directory |
| Effort level | Reads `CLAUDE_CODE_EFFORT_LEVEL` env var or `settings.json` |
| Git branch | Detected automatically, silently absent if not a git repo |

---

## Platform support

The Rust binary is pre-built and installed automatically for your platform via npm `optionalDependencies`:

| Platform | Package |
|---|---|
| Linux x64 | [`@alyibrahim/claude-statusline-linux-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-linux-x64) |
| Linux arm64 | [`@alyibrahim/claude-statusline-linux-arm64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-linux-arm64) |
| macOS x64 (Intel) | [`@alyibrahim/claude-statusline-darwin-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-darwin-x64) |
| macOS arm64 (Apple Silicon) | [`@alyibrahim/claude-statusline-darwin-arm64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-darwin-arm64) |
| Windows x64 | [`@alyibrahim/claude-statusline-win32-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-win32-x64) |

npm picks the right one automatically. If your platform isn't listed, the JS fallback is used instead — no action needed.

---

## Why this one

| | claude-statusline | Others |
|---|---|---|
| Startup time | ~5ms (Rust binary) | ~100ms (Node.js cold-start every prompt) |
| Shell dependencies | None | Require `jq`, `bc`, or `ccusage` |
| API calls | None — reads Claude's stdin directly | Poll OAuth endpoint, risk rate limits |
| Subscription-aware | Shows usage/resets for Pro/Max, cost for API | Treat everyone as API user |
| Context bar | Usable % after auto-compact buffer | Raw remaining % |
| Subagent counter | Counts active agents from todos dir | — |

---

## Requirements

- **Node.js ≥16** — for install/uninstall scripts only (not needed at runtime on supported platforms)
- **git** — optional, enables branch display

---

## Uninstall

```bash
claude-statusline uninstall
npm uninstall -g @alyibrahim/claude-statusline
```

> Always run `claude-statusline uninstall` first — it removes the `statusLine` entry from `~/.claude/settings.json` before the files are deleted.

---

## Notes

- Settings are written only to the `statusLine` key — all other `~/.claude/settings.json` keys are untouched
- Respects `$CLAUDE_CONFIG_DIR` if set
- Switched Node versions on an unsupported platform? Re-run `claude-statusline setup`

## License

MIT
