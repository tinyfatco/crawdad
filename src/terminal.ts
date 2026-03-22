/**
 * terminal.ts — Native PTY ↔ WebSocket bridge.
 *
 * Provides a terminal session for the workspace UI when running standalone
 * (no orchestrator). Each WebSocket connection gets its own PTY process.
 *
 * Protocol (matches Cloudflare sandbox terminal protocol):
 *   Browser → Server:
 *     - Binary: PTY stdin (keystrokes)
 *     - Text/JSON: { type: "resize", cols: number, rows: number }
 *   Server → Browser:
 *     - Binary: PTY stdout
 *     - Text/JSON: { type: "ready" }
 *
 * When crawdad-cf is in front, it intercepts /agents/{id}/terminal at the
 * Worker level and calls sandbox.terminal() — the request never reaches
 * port 3002. This handler only fires in standalone mode.
 */

import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import * as log from "./log.js";

let ptyModule: typeof import("node-pty") | null = null;

async function getPty(): Promise<typeof import("node-pty")> {
	if (!ptyModule) {
		ptyModule = await import("node-pty");
	}
	return ptyModule;
}

const wss = new WebSocketServer({ noServer: true });

/**
 * Handle a WebSocket upgrade for /terminal.
 * Called from gateway.ts via registerUpgrade().
 */
export function handleTerminalUpgrade(
	workingDir: string,
): (req: IncomingMessage, socket: Socket, head: Buffer) => void {
	return (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
			startTerminalSession(ws, workingDir);
		});
	};
}

async function startTerminalSession(ws: WebSocket, workingDir: string): Promise<void> {
	log.logInfo("[terminal] PTY session started");

	let pty: import("node-pty").IPty;
	try {
		const nodePty = await getPty();
		const shell = process.env.SHELL || "/bin/bash";
		pty = nodePty.spawn(shell, [], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: workingDir,
			env: {
				...process.env,
				TERM: "xterm-256color",
			} as Record<string, string>,
		});
	} catch (err) {
		log.logWarning(`[terminal] Failed to spawn PTY: ${err instanceof Error ? err.message : err}`);
		ws.send(JSON.stringify({ type: "error", message: "Failed to spawn terminal" }));
		ws.close();
		return;
	}

	// Send ready signal (matches CF sandbox protocol)
	ws.send(JSON.stringify({ type: "ready" }));

	// PTY stdout → WebSocket (binary)
	pty.onData((data) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(Buffer.from(data, "utf-8"));
		}
	});

	// PTY exit → close WebSocket
	pty.onExit(({ exitCode, signal }) => {
		log.logInfo(`[terminal] PTY exited (code=${exitCode}, signal=${signal})`);
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
			ws.close();
		}
	});

	// WebSocket messages → PTY
	ws.on("message", (data, isBinary) => {
		if (isBinary || data instanceof Buffer) {
			// Binary = keystrokes → PTY stdin
			const text = data instanceof Buffer ? data.toString("utf-8") : Buffer.from(data as ArrayBuffer).toString("utf-8");
			pty.write(text);
		} else {
			// Text = JSON control message
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
					pty.resize(msg.cols, msg.rows);
				}
			} catch {
				// Not valid JSON — ignore
			}
		}
	});

	// WebSocket close → kill PTY
	ws.on("close", () => {
		log.logInfo("[terminal] WebSocket closed, killing PTY");
		try {
			pty.kill();
		} catch {
			// Already dead
		}
	});

	ws.on("error", (err) => {
		log.logWarning(`[terminal] WebSocket error: ${err.message}`);
		try {
			pty.kill();
		} catch {
			// Already dead
		}
	});
}
