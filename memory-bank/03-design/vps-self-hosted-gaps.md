# Self-Hosted / VPS Deployment Gaps

**Date:** 2026-03-21
**Status:** Analysis complete, implementation pending

## Context

Troublemaker can run as a standalone process on any server, but certain workspace features currently depend on an external orchestrator for their server-side implementation. This document captures what works standalone, what doesn't, and the path to making troublemaker fully self-contained.

## What works standalone

- Gateway HTTP server, health check, static UI serving
- Awareness SSE stream + backlog API (tail-first loading with lazy scroll-up)
- File explorer APIs (`/api/files`, `/api/file`, `/api/config`)
- All messaging adapters (Slack socket/webhook, Telegram polling/webhook, Discord, email, web chat, voice)
- The agent runtime (pi-agent-core)
- Scheduled events and heartbeat

## Gaps

### 1. Terminal (no PTY server)

The workspace terminal UI (xterm.js) connects to `/terminal` via WebSocket. Troublemaker has no server-side PTY handler — the WebSocket upgrade goes nowhere.

**Protocol:** Binary messages = PTY stdin, JSON text messages = control messages (`resize`, `ready`, `error`, `exit`). The client already speaks this protocol correctly.

**Fix:** Native PTY adapter using `node-pty` + `ws`. The gateway handles WebSocket upgrades on `/terminal`, spawns a shell, bridges I/O bidirectionally. No client changes needed.

**Dependencies:** `node-pty` (native, compiles on install), `ws` (already in package.json)

### 2. Desktop / VNC (no native proxy)

Desktop mode uses a noVNC iframe proxied through `/vnc/*` to a VNC server on port 6080 inside the container. The proxy logic lives in the orchestrator, not in troublemaker.

**Fix:** Native VNC WebSocket proxy in the gateway — forward `/vnc/*` HTTP and WebSocket traffic to localhost:6080. Requires a VNC server (Xvfb + x11vnc or similar) running alongside troublemaker on the host.

**Priority:** Lower than terminal. Desktop mode is a secondary display option; terminal covers the primary use case.

### 3. Auth (no access control)

The gateway has zero authentication. Access control is handled at the orchestrator/proxy layer.

**Fix:** Lightweight optional auth middleware in the gateway — token-based (env var `TROUBLEMAKER_AUTH_TOKEN`) for VPS deployments. Disabled by default for local dev. Applied to workspace routes (terminal, files, awareness, desktop) but not webhook endpoints (those have their own signature verification).

### 4. Container lifecycle (not troublemaker's concern)

Sleep/wake, persistent storage mounting, secrets injection, wake scheduling — these are orchestrator responsibilities. A VPS deployment manages its own process lifecycle (systemd, Docker, etc). Not a gap to fix in troublemaker.

## Architecture Direction

Considering a pluggable adapter pattern for terminal and desktop, analogous to how messaging adapters (Slack, Telegram, etc.) are selected at startup. A `TerminalAdapter` interface would allow different backends:

- **Native:** `node-pty` shell spawn, direct WebSocket bridge (VPS/Docker/bare metal)
- **Noop:** Rejects connections gracefully when terminal is handled externally or unavailable
- **Future:** SSH proxy to remote host, Docker exec into sibling container, etc.

Same pattern for desktop (VNC proxy vs. external vs. disabled).

The gateway would accept these adapters via constructor options, keeping transport-specific logic out of the core routing.

## Priority

1. **Terminal** — highest impact, cleanest seam, well-defined protocol
2. **Auth** — required before any internet-exposed deployment
3. **Desktop/VNC** — nice-to-have, extends the workspace experience
