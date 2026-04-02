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
- **History Dashboard:** Running `claude-statusline history` generates a self-contained HTML dashboard and opens it in the browser. It displays an interactive session log with per-project filtering, summary stats (total sessions, tokens in/out, total spend), light/dark theme toggle, and per-row detail for model, duration, cost, and exit reason.

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
- **Fail-safe Design:** 3-second stdin timeout guard; silently discards bad JSON to strictly guarantee Claude Code never crashes due to the statusline.
- **Performance Optimizations:** A byte-offset cache (`~/.claude/statusline-tokcache-{session}.json`) avoids re-parsing the full token JSONL on each invocation, keeping latency flat as session length grows.
- **Dependency Profile:** Zero runtime shell dependencies (no `jq`, `bc`).

### 4.4. Lifecycle & Platform
- **Installation:** Natively distributed as OS-specific npm packages (`@alyibrahim/claude-statusline-*`).
- **CLI Commands:**
  - `claude-statusline setup` — atomic update of `~/.claude/settings.json`; enables history hooks by default.
  - `claude-statusline uninstall` — strips the `statusLine` key without affecting other settings.
  - `claude-statusline enable-history` / `disable-history` — toggles `SessionStart` and `SessionEnd` hooks in settings.
  - `claude-statusline history` — generates and opens the session history dashboard in the browser.
- **History Tracking:** Triggered via Claude Code's native `SessionStart` / `SessionEnd` hooks, enabled automatically on first setup.

## 5. GitHub Workflows

### 5.1. CI (`ci.yml`)
- **Trigger:** Every push and pull request to `main`.
- **Purpose:** Runs the Jest test suite (`npm ci && npm test`) against Node.js 18, 20, and 22 in a matrix to catch regressions across supported runtimes before merge. The Rust test suite (68 unit tests) is run separately per-platform as part of the release workflow.

### 5.2. Release (`release.yml`)
- **Trigger:** Any tag matching `v*` pushed to the repository.
- **Purpose:** Cross-compiles the Rust binary for all five supported platform targets, sets the version from the tag, and publishes each platform-specific npm package (`@alyibrahim/claude-statusline-{platform}-{arch}`) followed by the root package once all platform jobs succeed. Skips re-publishing if a given version is already present on npm (idempotent).
- **Targets:** `linux-x64`, `linux-arm64` (via `cross`), `darwin-x64`, `darwin-arm64` (macOS 14 runner), `win32-x64`.

### 5.3. Capture Dashboard (`capture-dashboard.yml`)
- **Trigger:** Any push to `main` that modifies files under `dashboard-design/`.
- **Purpose:** Serves the dashboard locally via `http-server`, launches a headless Chromium browser via a Playwright script, waits for network idle (ensuring `mockData.jsonl` is fetched and rendered), waits for table rows to appear in the DOM, then waits for all CSS animations to complete before taking a full-page screenshot. Commits the result to `assets/dashboard-preview.png` with `[skip ci]` to avoid re-triggering the pipeline.

## 6. Success Metrics
- Startup latency ~5ms (Rust binary); < 150ms (Node.js fallback).
- 0% occurrence of statusline-induced crashes in the main Claude Code process.
- Seamless installation on Linux (x64/arm64), macOS (x64/arm64), and Windows (x64).
