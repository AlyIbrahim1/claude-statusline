# AGENTS.md

This file provides guidance to any AI agent when working with code in this repository.

## Commands

- `npm test` — run all Jest tests
- `npm test -- --testPathPattern=setup` — run a single test file
- `node node_modules/jest/bin/jest.js` — run Jest directly (use if `npm test` fails with permission error)
- `cargo build --release` — build the Rust binary locally (requires Rust toolchain)
- `cargo test -- --test-threads=1` — run Rust unit tests (tests mutate global env vars and must not run in parallel)
- `claude-statusline setup` — configure ~/.claude/settings.json
- `claude-statusline uninstall` — remove from settings.json
- `npm install -g @alyibrahim/claude-statusline` — install globally

## Architecture

Two independent halves that never call each other, sharing only the settings path via `scripts/config.js`:

**Rust binary** (`src/main.rs`): the primary renderer since v1.1.0. Pre-compiled per-platform and distributed as optional npm packages (`@alyibrahim/claude-statusline-{platform}-{arch}`). Falls back to `statusline.js` when no binary is found.

**History module** (`src/history.rs`, mirrored by `scripts/history.js`): handles `hook end` and `history`. `hook start` is a no-op kept for SessionStart hooks written by older versions. At SessionEnd it catches up on the transcript, appends one line `h([id8,project,model,start,dur,in,cache,out,cost,reason]);` to `<config>/statusline/history.js`, deletes that session's state file (and records nothing when there is none: another SessionEnd hook already finalized it), finalizes state files untouched for 24h, and migrates legacy files. The first render of each session deletes state files untouched for 7 days without recording them, so they are cleaned up even with history disabled. Cost is written as an integer when whole (`2`, not `2.0`). The history file is append-only; readers keep the last line per id. Both implementations must write byte-identical lines. `history` installs `dashboard-design/dashboard.html` (one self-contained file, embedded in the binary via `include_str!`) to `<config>/statusline/dashboard.html` when its content differs, then opens it; the page loads `history.js` via `<script src>` and must build rows with `textContent`, never `innerHTML`. `dashboard-design/history.js` is sample data for previewing the page from the repo.

**Input model** (`src/status_model.rs`): parses stdin JSON into a typed struct.

**Session state** (`src/session.rs`, mirrored by `scripts/session.js`): per-session file at `<config>/statusline/sessions/<session_id>.json` holding transcript read cursors, deduplicated token totals (`tin` = input + cache writes, `tcache` = cache reads, `tout` = output) and git commit baselines. Tokens are read incrementally from stdin `transcript_path` plus `<transcript stem>/subagents/*.jsonl`; adjacent entries with the same `message.id:requestId` are counted once. Git branch/SHA are read from `.git` directly; `git` is spawned only for unusual layouts and for `rev-list --count` when HEAD moves. Both implementations must produce identical output and state.

**Runtime half** (`statusline.js`): invoked by Claude Code at runtime. Reads JSON from stdin, renders a 2-line ANSI statusline to stdout. Has a 3-second timeout guard on stdin. Silently discards JSON parse errors — must never crash Claude Code.

**Lifecycle half** (`scripts/`): runs at install/uninstall time and via the CLI.
- `scripts/config.js` — `getSettingsPath()` (respects `$CLAUDE_CONFIG_DIR`), `atomicWrite()` (write to `.tmp` then rename), `resolveBinary()` (searches optionalDependency packages for a platform binary, returns path or null)
- `scripts/setup.js` — adds/updates the `statusLine` key and the SessionEnd hook in settings.json, preserves all other keys. `statuslineCommand()` builds the one command used for both (binary if installed, else node + statusline.js) and validates it for unsafe shell chars. `hooks/hooks.json` is the settings template (`${STATUSLINE_CMD}`, `${HOOK_MARKER}`); `hooks/plugin-hooks.json` is what the plugin registers (only `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code in plugin hooks)
- `scripts/uninstall.js` — removes the `statusLine` key, our hooks and our slash commands, preserves other settings; with `{ removeData: true }` (CLI only, never npm lifecycle) also deletes `<config>/statusline/` and `dashboardMode`. npm 7+ never runs `preuninstall`, so users must run `claude-statusline uninstall` first
- `scripts/plugin-autosetup.js` — exports `pluginAutoSetup()`, run by the plugin's SessionStart hook (and postinstall when `CLAUDE_PLUGIN_ROOT` is set); configures `statusLine` in settings.json using the binary (preferred) or JS fallback when none is set, and repoints one that runs another version folder of this plugin (plugin updates). Never writes a settings.json it cannot parse. `--force` (used by the plugin `/setup` command) replaces any existing statusLine
- `scripts/postinstall.js` — npm lifecycle hook; when `CLAUDE_PLUGIN_ROOT` is set (plugin install), calls pluginAutoSetup() and exits; otherwise runs the global-install setup path. Must always exit 0.
- `scripts/preuninstall.js` — npm lifecycle hook; must always exit 0
- `bin/cli.js` — CLI entry point

Settings are written to `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`. Only the `statusLine` key is ever modified.

## Version bumps

When bumping the version, `package.json`, `Cargo.toml`, `.claude-plugin/marketplace.json`, and `.claude-plugin/plugin.json` must **ALL** be updated to the same version. Then regenerate both `package-lock.json` and `Cargo.lock`.

```bash
npm install --package-lock-only
npm run check-versions
```

The lock file pins the platform-specific optionalDependencies (`@alyibrahim/claude-statusline-*`) to exact versions. If `package.json` and `package-lock.json` are out of sync, CI fails on `npm ci` before any tests run.

`Cargo.toml` version is not used by the build or CI, but it should always match `package.json` to keep the project state consistent and readable.

Before committing a version bump, check whether `README.md` needs updating — new features, changed commands, removed dependencies, or changed file paths should be reflected before the release commit goes out.

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. It refuses tags that do not match `package.json` or point off `main`, re-runs all of CI on the tagged commit, builds and runs every platform binary, publishes the platform packages, smoke-installs the package from the registry on every platform (`.github/scripts/smoke-install.js`), and only then publishes the root package:

```bash
git tag v1.x.x && git push origin main --tags
```

Before tagging: bump the version (see Version bumps; `packages/*/package.json` stay at `0.0.0` and are set by the release), run `npm run check-versions`, both test suites, `node .github/scripts/smoke-install.js --local-binary target/release/statusline` after `cargo build --release`, and check `README.md` for stale content.

## Conventions

- `atomicWrite` uses a `.tmp` file then renames — never write settings.json directly
- npm lifecycle hooks (`postinstall.js`, `preuninstall.js`) catch all errors and always exit 0; a failed hook must not fail `npm install` or `npm uninstall`
- Setup validates Node and script paths against unsafe shell characters (`"`, backticks, `$`, `!`; plus `\` and `()` except on Windows, where they are normal path characters) because the command is embedded in JSON as a shell string
- CI guard in `setup.js`: auto-setup is skipped unless `force=true` or `npm_config_global=true`, so local `npm install` does not modify settings
- Context window display normalizes by dividing raw context by `0.835` to account for the 16.5% auto-compact buffer
- Effort level comes only from stdin `effort.level`
- All settings-reading functions (setup, uninstall, toggleHistory, getDashboardMode, setDashboardMode) validate that parsed settings.json is a plain object before proceeding — prevents crashes on null, array, or string JSON values

## Tests

150 Jest tests in `tests/`. Each test file uses `fs.mkdtempSync` for directory isolation and overrides `$CLAUDE_CONFIG_DIR`. Tests that cover module side effects (hooks) must clear the require cache between runs: `delete require.cache[require.resolve('../scripts/postinstall')]`. `cli-mode.test.js` covers `--mode web|terminal` flag parsing, mode persistence in settings.json, binary fallback, and binary dispatch behavior.

96 Rust tests in `tests/rust_unit/`, referenced from source files via `#[path]`: `main_tests.rs` (65), `session_tests.rs` (13), `history_tests.rs` (14), `history_tui_tests.rs` (4). Run with `cargo test -- --test-threads=1`.

## Commits

- **NEVER** add co-author notes.
- **Always** try to use atomic commit principles by separating the changes into groups.
- **Always** make sure that the code passed all tests and that the versions are properly aligned before committing.
