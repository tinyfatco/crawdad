# Current Work

**Last updated:** 2026-04-21

## 2026-04-21 — Awareness pub/sub refactor (branch: feat/pubsub-awareness)

Web chat had three parallel pipes carrying the same tokens:
(1) per-turn SSE from `/web/chat`,
(2) 500ms file-poll SSE from `/awareness/stream`,
(3) Worker re-framing of #1.

Collapsed to one. `src/awareness-bus.ts` is a singleton EventEmitter.
Every writer to `awareness/context.jsonl` publishes to the bus
(commands.ts, presence.ts, adapters/operator.ts). `gateway.ts`'s
`/awareness/stream` subscribes to the bus and uses `fs.watch` as a
backstop for pi-coding-agent's SessionManager (which we don't control).
The old 500ms `setInterval` + `statSync` loop is gone.

Web adapter (`adapters/web.ts`) is now POST-and-200. No SSE. Agent
output reaches the UI through the awareness stream — the single source
of truth. ChatPane/useWebChat simplified to match.

Zip is running this branch via `troublemaker_branch` override.

## Status: Self-Hosted Runtime Is Real

### Native Terminal PTY — Shipped

`node-pty` + WebSocket upgrade handler in `src/terminal.ts`. Gateway registers `UPGRADE /terminal` route. Works standalone and through crawdad-cf. UI hooks updated to connect to gateway port instead of requiring sandbox terminal proxy.

### Ghost — Standalone Agent on Tiny-Bat

Proof of concept for self-hosted troublemaker:
- Git worktree at `~/troublemaker-ghost` (branch `ghost-dev`)
- Data at `~/ghost-data` with `settings.json` + `MEMORY.md`
- Running Kimi K2.5 via Fireworks API (`FIREWORKS_API_KEY`)
- ElevenLabs voice working (voice ID `qA5SHJ9UjGlW2QwXWR7w`)
- 28ms startup. Terminal, web chat, voice, awareness stream all functional.
- Auth: SSH tunnel. No tokens needed. Gateway trusts localhost.
- Heartbeat running — Kimi autonomously doing background work.

### Message Dedup — Fixed After 3 Iterations

The web chat had a persistent duplication bug: optimistic entries (shown immediately) overlapped with SSE entries (from context.jsonl). Three attempts:
1. ID dedup on SSE insert — caught reconnections but not optimistic overlap
2. Clear optimistic on complete — caused visible flash
3. **Final:** `showStreaming` flag. Streaming entry stays visible until SSE delivers an assistant entry with timestamp >= streaming timestamp, then yields. No flash, no duplication. Voice and cross-channel messages pass through unfiltered.

### UI Polish — Shipped

- Timestamps in meta row (top-left)
- Flat card styling (2px radius, minimal padding)
- Assistant cards with background + border
- Tool calls: `→ label` format matching Telegram/Slack
- Table formatting for markdown tables
- Loading screen: `#1a1a1a`, spinner on top, "Waking up..."

### Next P0: Real-Time Awareness Stream

SSE polls context.jsonl on an interval — noticeable delay between agent work and UI update. Need `fs.watch` push or sub-second polling for real-time feel. Critical for heartbeat/spontaneity where agent works in background.

## Architecture

- **Gateway:** HTTP server on configurable port (default 3002). Serves static UI, REST endpoints, SSE stream, WebSocket upgrade for terminal.
- **Voice:** Dedicated WebSocket server on port 8766. Vite dev server proxies `/voice/stream` there.
- **Adapters:** web, telegram, slack, discord, email, heartbeat, web-voice. Each independent.
- **Sandbox modes:** `host` (bare metal, tools run directly) or `docker:<name>` (isolated).

## Upstream

Pi agent core `@mariozechner/pi-agent-core@0.58.4`. 1M context for Claude 4.6. Models: Kimi K2.5 (Fireworks), Claude Sonnet 4.6, GPT-5.4 (Codex OAuth — currently rate-limited).
