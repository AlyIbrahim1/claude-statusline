# AGENTS.md

This file provides guidance to any AI agent when working with code in this repository.

## Commands

- `npm test` — run all Jest tests
- `npm test -- --testPathPattern=setup` — run a single test file
- `node node_modules/jest/bin/jest.js` — run Jest directly (use if `npm test` fails with permission error)
- `cargo build --release` — build the Rust binary locally (requires Rust toolchain)
- `cargo test` — run Rust unit tests (63 tests in `src/main.rs` and `src/history.rs`)
- `claude-statusline setup` — configure ~/.claude/settings.json
- `claude-statusline uninstall` — remove from settings.json
- `npm install -g @alyibrahim/claude-statusline` — install globally

## Architecture

Two independent halves that never call each other, sharing only the settings path via `scripts/config.js`:

**Rust binary** (`src/main.rs`): the primary renderer since v1.1.0. Pre-compiled per-platform and distributed as optional npm packages (`@alyibrahim/claude-statusline-{platform}-{arch}`). Falls back to `statusline.js` when no binary is found.

**History module** (`src/history.rs`): handles `hook start`, `hook end`, and `history` subcommands for the Rust binary. Stores sessions as append-only JSONL at `~/.claude/statusline-history.jsonl`. The JS fallback (`scripts/history.js`) uses the same file and format — both implementations share one history store.

**Runtime half** (`statusline.js`): invoked by Claude Code at runtime. Reads JSON from stdin, renders a 2-line ANSI statusline to stdout. Has a 3-second timeout guard on stdin. Silently discards JSON parse errors — must never crash Claude Code.

**Lifecycle half** (`scripts/`): runs at install/uninstall time and via the CLI.
- `scripts/config.js` — `getSettingsPath()` (respects `$CLAUDE_CONFIG_DIR`), `atomicWrite()` (write to `.tmp` then rename), and `resolveBinary()` (searches optionalDependency packages for a platform binary, returns path or null)
- `scripts/setup.js` — adds/updates the `statusLine` key in settings.json, preserves all other keys, validates paths for unsafe shell chars
- `scripts/uninstall.js` — removes the `statusLine` key, preserves other settings
- `scripts/postinstall.js` / `scripts/preuninstall.js` — npm lifecycle hooks; both must always exit 0
- `bin/cli.js` — CLI entry point

Settings are written to `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`. Only the `statusLine` key is ever modified.

## Version bumps

When bumping the version, **both** `package.json` (including the ones in `/packages`) and `Cargo.toml` must be updated to the same version. Then regenerate `package-lock.json`:

```bash
npm install --package-lock-only
```

The lock file pins the platform-specific optionalDependencies (`@alyibrahim/claude-statusline-*`) to exact versions. If `package.json` and `package-lock.json` are out of sync, CI fails on `npm ci` before any tests run.

`Cargo.toml` version is not used by the build or CI, but it should always match `package.json` to keep the project state consistent and readable.

Before committing a version bump, check whether `README.md` needs updating — new features, changed commands, removed dependencies, or changed file paths should be reflected before the release commit goes out.

## Release

Tagging a version triggers the CI pipeline which publishes to npm automatically:

```bash
git tag v1.x.x && git push origin main --tags
```

Before tagging: bump version in both `package.json` (including the ones in `/packages`) and `Cargo.toml`, regenerate `package-lock.json`, run both test suites (`npm test` and `cargo test`), and check `README.md` for stale content.

## Conventions

- `atomicWrite` uses a `.tmp` file then renames — never write settings.json directly
- npm lifecycle hooks (`postinstall.js`, `preuninstall.js`) catch all errors and always exit 0; a failed hook must not fail `npm install` or `npm uninstall`
- Setup validates Node and script paths against unsafe shell characters (backticks, `$`, `!`, etc.) because the command is embedded in JSON as a shell string
- CI guard in `setup.js`: auto-setup is skipped unless `force=true` or `npm_config_global=true`, so local `npm install` does not modify settings
- Context window display normalizes by dividing raw context by `0.835` to account for the 16.5% auto-compact buffer
- Effort level is read from `CLAUDE_CODE_EFFORT_LEVEL` env var first, then falls back to settings.json

## Tests

41 Jest tests in `tests/`. Each test file uses `fs.mkdtempSync` for directory isolation and overrides `$CLAUDE_CONFIG_DIR`. Tests that cover module side effects (hooks) must clear the require cache between runs: `delete require.cache[require.resolve('../scripts/postinstall')]`.

63 Rust tests inline in `src/main.rs` and `src/history.rs`. Run with `cargo test`.
