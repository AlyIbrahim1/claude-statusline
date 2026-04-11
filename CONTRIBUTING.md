# Contributing to claude-statusline

Thanks for your interest in contributing. This document covers everything you need to get started.

## Contributor License Agreement

Before your first pull request is merged, you'll be asked to sign the [CLA](CLA.md) by leaving a comment on the PR. The CLA bot handles this automatically — no separate form to fill out.

## Development Setup

**Prerequisites:** Node.js 16+ (18+ recommended), Rust toolchain (for binary changes only)

```bash
git clone https://github.com/AlyIbrahim1/claude-statusline.git
cd claude-statusline
npm install
```

## Project Architecture

Two independent halves that share only a settings path:

- **Rust binary** (`src/main.rs`, `src/history.rs`, `src/realtime.rs`, `src/realtime_paths.rs`, `src/status_model.rs`) — the primary renderer. Pre-compiled per platform and distributed as optional npm packages. `src/realtime.rs` implements the realtime event system (Unix sockets, state snapshots, terminal resize); `src/realtime_paths.rs` handles TTY slug derivation and realtime file paths; `src/status_model.rs` handles stdin JSON parsing. Realtime subcommands use `#[cfg(all(unix, not(test)))]` guards to prevent auto-spawning during `cargo test`, which would cause exponential process explosions.
- **JS fallback** (`statusline.js`, `scripts/`) — invoked when no binary is found. Lifecycle scripts run at install/uninstall time.

Changes to one half do not require touching the other.

## Running Tests

```bash
# JavaScript tests (102 tests)
npm test

# If npm test fails with "jest: Permission denied"
node node_modules/jest/bin/jest.js

# Rust tests (85 tests)
cargo test -- --test-threads=1
```

Rust tests mutate global env vars and must run single-threaded — omitting `--test-threads=1` will cause test failures or process explosions.

All tests must pass before a PR can be merged.

## Making Changes

### JavaScript changes

Edit files under `scripts/` or `statusline.js`. The JS side uses `atomicWrite` (write to `.tmp`, then rename) for all settings file operations — do not write `settings.json` directly. `scripts/config.js` also exports `getRealtimePaths()` and `getRealtimeTtySlug()` for realtime path resolution; use these rather than constructing paths manually. `scripts/slug-utils.js` exports `normalizeProjectSlug()` for cross-platform project path normalization — use this if your change touches history or token cache code.

If your change touches history slash commands:

- Source slash command files live in `.claude/commands/`.
- `scripts/postinstall.js` copies those files into `~/.claude/commands/` during global install.
- `scripts/preuninstall.js` removes only package-owned history command files and must not remove unrelated user commands.
- Add or update tests in `tests/slash-commands.test.js` for lifecycle behavior changes.

If your change touches history dashboard mode behavior:

- Keep `claude-statusline history --mode web|terminal` semantics intact.
- Ensure mode persistence via `dashboardMode` in Claude settings remains backward compatible.

### Rust changes

Edit `src/main.rs`, `src/history.rs`, `src/realtime.rs`, `src/realtime_paths.rs`, or `src/status_model.rs` as needed, then run `cargo build --release` to verify it compiles. When editing realtime code, keep the `#[cfg(all(unix, not(test)))]` guards in place — they prevent the realtime renderer from auto-spawning during `cargo test`.

### Version bumps

If your change warrants a version bump, update all **four** manifest files to the same version: `package.json`, `Cargo.toml`, `.claude-plugin/marketplace.json`, and `.claude-plugin/plugin.json`. Then regenerate the lock file and validate alignment:

```bash
npm install --package-lock-only
npm run check-versions
```

Also check `README.md` for any stale content before committing.

## Pull Request Guidelines

- One logical change per PR.
- Include a clear description of what changed and why.
- Make sure `npm test` and `cargo test` both pass locally before opening the PR.
- Keep commit messages concise and in the imperative mood (`fix: …`, `feat: …`).

## Reporting Bugs

Open an issue with:
- Claude Code version (`claude --version`)
- OS and architecture
- The full statusline output or error, if applicable
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) and subject to the [CLA](CLA.md).
