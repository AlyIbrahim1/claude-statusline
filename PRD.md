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
- **Latency Overheads:** Existing Node/shell-based status lines add ~100ms lag per prompt. This tool utilizes a pre-compiled Rust binary to hit a ~5ms execution target.
- **Silent Rate Limits:** Users are often unaware of weekly or 5-hour usage limits until they are blocked.
- **Lack of Session History:** Claude Code does not natively provide summarized historical data of past sessions across projects.

## 4. Key Features & Requirements
### 4.1. Core Capabilities
- **Real-Time Token Tracking:** Intercepts Claude Code's JSONL telemetry for continuous update without waiting for the next turn.
- **Session Cost Calculation:** Live display of session costs for API key users.
- **Subscription Awareness:** Intelligent toggling between usage/reset timers (Pro/Max plans) and direct API costs based on user subscription type.
- **Context Bar Normalization:** Calculates "usable %" by factoring out the 16.5% auto-compact buffer.
- **Session History:** Tracks session start and end events using Claude Code hooks, storing metrics in a lightweight local sequence (`~/.claude/statusline-history.jsonl`).

### 4.2. Developer Ergonomics
- **Extrinsic State Tracking:** 
  - Git Branch Context including dirty-tree indicators and commits made within the session (`+N`).
  - Active subagent counter (via `~/.claude/todos/`).
  - Effort level display based on ENV or `.claude` properties.
  - Active path/directory label (`~/parent/dir`).

### 4.3. Performance & Architecture
- **Execution Target:** Under 10ms (Rust binary) for the primary statusline renderer (`src/main.rs`).
- **Separation of Concerns:** A dedicated History module (`src/history.rs`) manages hook execution, avoiding any database/file writes during the real-time prompt loop.
- **Graceful Fallback:** Node.js fallback (`statusline.js` and `history.js`) natively distributed without compilation steps for unsupported OS/Arch combos.
- **Fail-safe Design:** 3-second stdin timeout guard; silently discards bad JSON to strictly guarantee Claude Code never crashes due to the statusline.
- **Dependency Profile:** Zero runtime shell dependencies (no `jq`, `bc`).

### 4.4. Lifecycle & Platform
- **Installation:** Natively distributed as OS-specific npm packages (`@alyibrahim/claude-statusline-*`).
- **Setup:** Self-configuring (`claude-statusline setup`), performing an atomic update of `~/.claude/settings.json`.
- **History Tracking:** Triggered cleanly via Claude Code's native `SessionStart` / `SessionEnd` hooks.
- **Uninstallation:** Safely strips modifications (`claude-statusline uninstall`) without affecting user settings.

## 5. Success Metrics
- Startup latency < 10ms.
- 0% occurrence of statusline-induced crashes in the main Claude Code process.
- Seamless installation on Linux (x64/arm64), macOS (x64/arm64), and Windows (x64).
