# Product Requirements Document: claude-statusline

## 1. Overview
`claude-statusline` is a highly optimized, cross-platform terminal statusline designed specifically for **Claude Code** (`claude.ai/code`). It intercepts real-time session telemetry to provide developers with immediate, low-latency visibility into critical metrics such as context window usage, token burn rate, API costs, active git branch, and running subagents. 

## 2. Target Audience
- Heavy users of the Claude Code interactive CLI.
- Developers concerned with context window limits, token costs, and rate limits.
- Engineers seeking an unobtrusive, zero-delay terminal utility in their tooling pipeline.

## 3. Core Problems Solved
- **Opaque Context Windows:** Users often hit context ceilings unexpectedly. `claude-statusline` normalizes the context bar dynamically.
- **Hidden Costs:** Fast, autonomous agents burn tokens rapidly. Real-time cost tracking is essential.
- **Latency Overheads:** Existing Node/shell-based status lines add ~100ms startup overhead per prompt. This tool utilizes a pre-compiled Rust binary to hit a ~5ms execution target; the Node.js fallback retains the ~100ms baseline.
- **Silent Rate Limits:** Users are often unaware of weekly or 5-hour usage limits until they are blocked.
- **Lack of Session History:** Claude Code does not natively provide summarized historical data of past sessions across projects.

## 4. Key Features & Requirements
### 4.1. Core Capabilities
- **Real-Time Token Tracking:** Intercepts Claude Code's JSONL telemetry for continuous update without waiting for the next turn. Cache-read tokens are weighted at 10% of normal input tokens to reflect their reduced cost in Claude's pricing model.
- **Session Cost Calculation:** Live display of session costs for API key users.
- **Subscription Awareness:** Intelligent toggling between usage/reset timers (Pro/Max plans) and direct API costs based on user subscription type.
- **Context Bar Normalization:** Calculates "usable %" by factoring out the 16.5% auto-compact buffer.
- **Session History:** Tracks session start and end events using Claude Code hooks, storing metrics in an append-only JSONL file at `~/.claude/statusline-history.jsonl`. History tracking is **enabled by default** on setup and can be toggled via `enable-history` / `disable-history` CLI commands.
- **History Dashboard (Web + Terminal):** Running `claude-statusline history` opens history in the user's saved mode. Web mode generates a self-contained HTML dashboard in the browser with project filtering, summary stats (total sessions, tokens in/out, total spend), light/dark theme toggle, and per-row detail for model, duration, cost, and exit reason. Terminal mode opens an interactive full-screen TUI.
- **Claude Slash Commands:** History management is also available as Claude Code slash commands (`/history`, `/history-enable`, `/history-disable`, `/history-mode <web|terminal>`). Command files are provided in `.claude/commands/` for project contributors and installed to `~/.claude/commands/` on global npm install.
- **Realtime State Sync (optional):** An optional background renderer process can be enabled per terminal via the `CLAUDE_STATUSLINE_REALTIME=1` environment variable (also accepts `"true"`/`"TRUE"`). When enabled, it auto-spawns on first render and maintains a per-TTY Unix socket and state file at `~/.claude/statusline-state-{tty_slug}.json`. The TTY slug is derived in priority order from `CLAUDE_STATUSLINE_TTY` → `TERM_SESSION_ID` → `pid-{PID}`. Each terminal session is fully isolated; a 5-minute heartbeat timeout auto-removes stale registry entries. Terminal resize events are handled via crossterm (Unix only). On Windows, the feature flag is silently ignored.

### 4.2. Developer Ergonomics
- **Extrinsic State Tracking:** 
  - Git Branch Context including dirty-tree indicators and commits made within the session (`+N`).
  - Active subagent counter (via `~/.claude/todos/`).
  - Effort level display with a fallback hierarchy: `CLAUDE_CODE_EFFORT_LEVEL` env var → `settings.json` → model-based default (medium for Sonnet/Opus 4, empty otherwise).
  - Active path/directory label (`~/parent/dir`).

### 4.3. Performance & Architecture
- **Execution Target:** ~5ms for the Rust binary; ~100ms for the Node.js fallback. Both are acceptable; the Rust path is preferred.
- **Separation of Concerns:** A dedicated History module (`src/history.rs`) manages hook execution, avoiding any database/file writes during the real-time prompt loop.
- **Graceful Fallback:** At runtime, the CLI resolves the platform Rust binary first; if not found, it falls back to the Node.js renderer. The fallback is distributed in the root npm package without compilation steps, covering unsupported OS/Arch combinations.
- **Fail-safe Design:** 3-second stdin timeout guard; silently discards bad JSON to strictly guarantee Claude Code never crashes due to the statusline. Settings-reading functions (`setup`, `uninstall`, `toggleHistory`, `getDashboardMode`, `setDashboardMode`) validate that parsed settings.json is a plain object before proceeding, preventing crashes on malformed-but-valid JSON (e.g. `null`, arrays, strings).
- **Performance Optimizations:** A byte-offset cache (`~/.claude/statusline-tokcache-{session}.json`) avoids re-parsing the full token JSONL on each invocation, keeping latency flat as session length grows.
- **Dependency Profile:** Zero runtime shell dependencies (no `jq`, `bc`).
- **Realtime Renderer Isolation:** The realtime renderer runs as a completely separate process launched via the `realtime run` subcommand. It communicates with the main render path exclusively through Unix sockets and JSON state files, with no shared in-process state. Spawn calls are gated behind `#[cfg(not(test))]` guards to prevent test-suite spawn loops.

### 4.4. Lifecycle & Platform
- **Installation:** Natively distributed as OS-specific npm packages (`@alyibrahim/claude-statusline-*`).
- **CLI Commands:**
  - `claude-statusline setup` — atomic update of `~/.claude/settings.json`; enables history hooks by default.
  - `claude-statusline uninstall` — strips the `statusLine` key without affecting other settings.
  - `claude-statusline enable-history` / `disable-history` — toggles `SessionStart` and `SessionEnd` hooks in settings.
  - `claude-statusline history` — opens history in saved mode (`web` by default).
  - `claude-statusline history --mode web|terminal` — switches mode and persists it.
  - `claude-statusline download-binary` — downloads the pre-compiled native binary for plugin users who skip the npm install step.
  - `claude-statusline realtime-status` — shows the current realtime renderer state and the socket/state file paths for the active terminal.
  - `claude-statusline realtime-stop` — requests renderer shutdown for the current terminal session.
- **Claude Code Slash Commands:**
  - `/history` — opens history in the saved dashboard mode.
  - `/history-enable` / `/history-disable` — toggles history tracking.
  - `/history-mode <web|terminal>` — changes persisted dashboard mode.
  - `/download-binary` — downloads the native binary from within a Claude Code session (for plugin users).
- **History Tracking:** Triggered via Claude Code's native `SessionStart` / `SessionEnd` hooks, enabled automatically on first setup.
- **Mode Persistence:** History mode is persisted in Claude settings (`dashboardMode`) and reused on subsequent `history` invocations.
- **Install/Uninstall Command Lifecycle:** Global installs copy project slash command files into `~/.claude/commands/`. Uninstall removes only the package-owned history command files and leaves unrelated user commands untouched.

## 5. GitHub Workflows

### 5.1. CI (`ci.yml`)
- **Trigger:** Every push and pull request to `main`.
- **Purpose:** Runs the Jest test suite (154 tests via `npm ci && npm test`) against Node.js 18, 20, and 22 in a matrix to catch regressions across supported runtimes before merge. The Rust test suite (108 unit tests) is run per-platform with `--test-threads=1` (sequential, to prevent failures from global env var mutation); on success, CI dispatches a `release-ready` repository dispatch event that triggers the release workflow when the commit is a version tag. CI also runs `check-version-alignment.js` to enforce that `package.json`, `package-lock.json`, `Cargo.toml`, and both plugin manifest files (`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`) all declare the same version.

### 5.2. Release (`release.yml`)
- **Trigger:** A `release-ready` repository dispatch event sent by CI after all tests pass on a version-tag commit. The tag push itself initiates the pipeline via CI, but the release jobs do not start until CI explicitly signals readiness — ensuring no release fires before the test suite is green.
- **Purpose:** Cross-compiles the Rust binary for all five supported platform targets, sets the version from the tag, and publishes each platform-specific npm package (`@alyibrahim/claude-statusline-{platform}-{arch}`) followed by the root package once all platform jobs succeed. Skips re-publishing if a given version is already present on npm (idempotent).
- **Targets:** `linux-x64`, `linux-arm64` (via `cross`), `darwin-x64`, `darwin-arm64` (macOS 14 runner), `win32-x64`.

### 5.3. Capture Dashboard (`capture-dashboard.yml`)
- **Trigger:** Any push to `main` that modifies files under `dashboard-design/`.
- **Purpose:** Serves the dashboard locally via `http-server`, launches a headless Chromium browser via a Playwright script, waits for network idle (ensuring `mockData.jsonl` is fetched and rendered), waits for table rows to appear in the DOM, then waits for all CSS animations to complete before taking a full-page screenshot. Commits the result to `assets/dashboard-preview.png` with `[skip ci]` to avoid re-triggering the pipeline.

## 6. Success Metrics
- Startup latency ~5ms (Rust binary); < 150ms (Node.js fallback).
- 0% occurrence of statusline-induced crashes in the main Claude Code process.
- Seamless installation on Linux (x64/arm64), macOS (x64/arm64), and Windows (x64).
