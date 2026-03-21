# Current Work

## Self-Hosted Runtime Gaps

Troublemaker runs as a standalone agent runtime but currently relies on an external orchestrator for terminal PTY, desktop VNC, and auth. We're designing native fallbacks so troublemaker has a complete self-hosted story on any VPS or bare metal.

### Terminal PTY
- Workspace UI connects to `/terminal` via WebSocket but there's no server-side PTY handler in troublemaker
- Need a native adapter using `node-pty` + `ws` that the gateway activates on WebSocket upgrade
- Client protocol is already correct (binary = stdin, JSON = control messages) — no UI changes needed
- Design doc: `memory-bank/03-design/vps-self-hosted-gaps.md`

### Desktop VNC
- The noVNC proxy for desktop mode (`/vnc/*` routes) is handled externally
- Need a native path for VPS deployments — either embedded noVNC proxy or direct VNC WebSocket bridge
- Lower priority than terminal but part of the same abstraction

### Auth
- Gateway has zero authentication — access control is handled by the orchestrator layer
- VPS deployments need a lightweight auth middleware (token-based or basic auth)
- Should be optional — disabled for local dev, enabled via env var

### Architecture Direction
Considering a pluggable adapter pattern for terminal and desktop, similar to how messaging adapters work. The abstraction should allow different backends (native PTY, external orchestrator, future options) without changing the gateway or UI code. Still marinating on the right shape.

### Status
Analysis complete. Design docs written. Implementation pending.

## Upstream Pi Dependency (0.58.4)

Bumped to `@mariozechner/pi-agent-core@0.58.4` (from 0.52.10). Includes 1M context support for Claude 4.6, compaction bugfixes, and `AuthStorage` constructor changes (now uses static factories).
