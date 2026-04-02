# Contributing to claude-statusline

Thanks for your interest in contributing. This document covers everything you need to get started.

## Contributor License Agreement

Before your first pull request is merged, you'll be asked to sign the [CLA](CLA.md) by leaving a comment on the PR. The CLA bot handles this automatically — no separate form to fill out.

## Development Setup

**Prerequisites:** Node.js 18+, Rust toolchain (for binary changes only)

```bash
git clone https://github.com/AlyIbrahim1/claude-statusline.git
cd claude-statusline
npm install
```

## Project Architecture

Two independent halves that share only a settings path:

- **Rust binary** (`src/main.rs`, `src/history.rs`) — the primary renderer. Pre-compiled per platform and distributed as optional npm packages.
- **JS fallback** (`statusline.js`, `scripts/`) — invoked when no binary is found. Lifecycle scripts run at install/uninstall time.

Changes to one half do not require touching the other.

## Running Tests

```bash
# JavaScript tests (41 tests)
npm test

# Rust tests (63 tests)
cargo test
```

All tests must pass before a PR can be merged.

## Making Changes

### JavaScript changes

Edit files under `scripts/` or `statusline.js`. The JS side uses `atomicWrite` (write to `.tmp`, then rename) for all settings file operations — do not write `settings.json` directly.

### Rust changes

Edit `src/main.rs` or `src/history.rs`, then run `cargo build --release` to verify it compiles.

### Version bumps

If your change warrants a version bump, update **both** `package.json` **and** `Cargo.toml` to the same version, then regenerate the lock file:

```bash
npm install --package-lock-only
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
