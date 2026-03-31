<div align="center">

# Platform Compatibility Guide

**claude-statusline** runs on every platform that supports Node.js ≥16.  
Pre-built Rust binaries are provided for the five most common targets. All others fall back to a JavaScript implementation automatically.

</div>

---

<div align="center">

## Supported Platforms

</div>

| Platform | Architecture | Binary | npm Package |
|---|---|---|---|
| Linux | x64 | `statusline` (ELF) | [`@alyibrahim/claude-statusline-linux-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-linux-x64) |
| Linux | arm64 | `statusline` (ELF) | [`@alyibrahim/claude-statusline-linux-arm64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-linux-arm64) |
| macOS | x64 (Intel) | `statusline` (Mach-O) | [`@alyibrahim/claude-statusline-darwin-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-darwin-x64) |
| macOS | arm64 (Apple Silicon) | `statusline` (Mach-O) | [`@alyibrahim/claude-statusline-darwin-arm64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-darwin-arm64) |
| Windows | x64 | `statusline.exe` (PE) | [`@alyibrahim/claude-statusline-win32-x64`](https://www.npmjs.com/package/@alyibrahim/claude-statusline-win32-x64) |
| Any other | any | JS fallback | _(no binary package required)_ |

The correct binary package is selected automatically by npm at install time based on `process.platform` and `process.arch`. You never need to specify it manually.

---

<div align="center">

## Linux

</div>

Covers all x64 and arm64 distributions: **Ubuntu, Debian, Arch Linux, Fedora, RHEL, Alpine, openSUSE, Manjaro, Pop!_OS**, and others. The binary is a statically-linked ELF with no libc or distro-specific runtime dependencies.

**Install:**

```bash
npm install -g @alyibrahim/claude-statusline
```

**Setup (if not auto-configured):**

```bash
claude-statusline setup
```

Settings are written to `~/.claude/settings.json`. Restart Claude Code to activate.

**Custom config directory:**

```bash
CLAUDE_CONFIG_DIR=/path/to/config claude-statusline setup
```

**Notes:**
- Requires Node.js ≥16 for the install scripts — the binary itself has no Node dependency at runtime
- `git` is optional but required for branch display
- WSL2 (Windows Subsystem for Linux) is fully supported — treated as Linux x64

---

<div align="center">

## macOS

</div>

Two separate binaries are provided: one for **Intel (x64)** Macs and one for **Apple Silicon (arm64)** Macs. npm picks the correct one automatically.

**Install:**

```bash
npm install -g @alyibrahim/claude-statusline
```

**Setup (if not auto-configured):**

```bash
claude-statusline setup
```

**Gatekeeper / "unverified developer" warning:**

If macOS blocks the binary on first run, clear the quarantine flag:

```bash
xattr -d com.apple.quarantine $(which claude-statusline)
```

Or allow it via **System Settings → Privacy & Security → Allow Anyway**.

**Notes:**
- Homebrew Node.js and nvm Node.js both work
- `git` ships with Xcode Command Line Tools (`xcode-select --install`) — install once to enable branch display

---

<div align="center">

## Windows

</div>

The Windows binary is a standard PE executable (`statusline.exe`). Supported on **Windows 10 and Windows 11**, x64 only.

**Install (PowerShell or Command Prompt):**

```powershell
npm install -g @alyibrahim/claude-statusline
```

**Setup (if not auto-configured):**

```powershell
claude-statusline setup
```

Settings are written to `%USERPROFILE%\.claude\settings.json`.

**Notes:**
- Paths containing backticks, `$`, `!`, or `()` are rejected by setup as unsafe shell characters — avoid installing to such paths
- `git` for Windows provides branch display — install from [git-scm.com](https://git-scm.com) if not already present
- WSL2 users: run the install inside WSL, not in the Windows host — you get the Linux binary and Linux paths that way

---

<div align="center">

## JS Fallback (unsupported platforms)

</div>

If no pre-built binary is found for your platform (e.g. Linux arm32, FreeBSD, or other architectures), the JS fallback is used automatically. No configuration needed — setup detects this and writes the Node.js command instead.

**What changes with the fallback:**

| | Rust binary | JS fallback |
|---|---|---|
| Startup time | ~5ms | ~100ms |
| Runtime dependency | None | Node.js ≥16 |
| Feature parity | Full | Full |

All features work identically. The only difference is startup latency — visible as a brief delay before the statusline appears after each response.

To force a re-check after updating Node.js or switching platforms:

```bash
claude-statusline setup
```

---

<div align="center">

## Feature Availability by Platform

</div>

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| Rust binary (~5ms) | x64, arm64 | x64, arm64 | x64 |
| JS fallback | All others | — | — |
| Git branch display | ✓ (requires git) | ✓ (requires git) | ✓ (requires git for Windows) |
| Session history (SQLite) | ✓ | ✓ | ✓ |
| Rate limits / usage | ✓ | ✓ | ✓ |
| Session cost | ✓ | ✓ | ✓ |
| Context bar | ✓ | ✓ | ✓ |
| `$CLAUDE_CONFIG_DIR` override | ✓ | ✓ | ✓ |

---

<div align="center">

## CLI Reference

</div>

These commands work identically on all platforms:

```bash
claude-statusline setup            # Write statusLine config to settings.json
claude-statusline uninstall        # Remove statusLine config from settings.json
claude-statusline history          # Open the session analytics dashboard in browser
claude-statusline enable-history   # Enable session tracking hooks
claude-statusline disable-history  # Remove session tracking hooks
```

> Always run `claude-statusline uninstall` before `npm uninstall -g` — it cleans up `settings.json` while the files are still present.

---

<div align="center">

## Settings Path Reference

</div>

| Platform | Default settings path |
|---|---|
| Linux / macOS | `~/.claude/settings.json` |
| Windows | `%USERPROFILE%\.claude\settings.json` |
| Custom | `$CLAUDE_CONFIG_DIR/settings.json` |

The `$CLAUDE_CONFIG_DIR` environment variable overrides the default on all platforms. Only the `statusLine` and `hooks` keys are ever modified — all other settings are preserved.
