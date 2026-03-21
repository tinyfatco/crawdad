import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, extname, resolve, normalize } from "path";
import * as log from "./log.js";

/**
 * Gateway — single HTTP server with path-based routing.
 * Serves adapter webhooks, API routes, and optionally a static web UI.
 */

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json",
};

export interface GatewayOptions {
	/** Directory containing built static files (index.html, assets/) */
	uiDir?: string;
	/** Directory to scope file API reads to */
	workspaceDir?: string;
}

export class Gateway {
	private routes = new Map<string, RouteHandler>();
	private getRoutes = new Map<string, RouteHandler>();
	private readyRoutes = new Set<string>();
	private server: Server | null = null;
	private uiDir: string | null = null;
	private workspaceDir: string | null = null;
	/** Connected SSE clients for /awareness/stream */
	private awarenessClients = new Set<ServerResponse>();
	private awarenessWatcher: ReturnType<typeof setInterval> | null = null;
	private awarenessFileSize = 0;

	constructor(options: GatewayOptions = {}) {
		if (options.uiDir && existsSync(options.uiDir)) {
			this.uiDir = resolve(options.uiDir);
			log.logInfo(`[gateway] serving UI from ${this.uiDir}`);
		}
		if (options.workspaceDir) {
			this.workspaceDir = resolve(options.workspaceDir);
		}
	}

	/** Register a POST route handler (e.g., "/slack/events" → adapter.dispatch) */
	register(path: string, handler: RouteHandler): void {
		this.routes.set(path, handler);
		log.logInfo(`[gateway] registered route: POST ${path}`);
	}

	/** Register a GET route handler (e.g., "/schedule") */
	registerGet(path: string, handler: RouteHandler): void {
		this.getRoutes.set(path, handler);
		log.logInfo(`[gateway] registered route: GET ${path}`);
	}

	/** Mark a route as ready to accept traffic. Until called, the route returns 503. */
	markReady(path: string): void {
		this.readyRoutes.add(path);
		log.logInfo(`[gateway] adapter ready: POST ${path}`);
	}

	/** Serve a static file from uiDir */
	private serveStatic(filePath: string, res: ServerResponse): void {
		try {
			const content = readFileSync(filePath);
			const ext = extname(filePath);
			const contentType = MIME_TYPES[ext] || "application/octet-stream";
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		} catch {
			res.writeHead(404);
			res.end("Not found");
		}
	}

	/** Handle GET /api/config — workspace configuration for the web UI */
	private handleConfigApi(_req: IncomingMessage, res: ServerResponse): void {
		if (this.workspaceDir) {
			try {
				const settingsPath = resolve(this.workspaceDir, "settings.json");
				const raw = readFileSync(settingsPath, "utf-8");
				const settings = JSON.parse(raw);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					display_mode: settings.display_mode === "desktop" ? "desktop" : "terminal",
					agent_name: settings.name || "agent",
				}));
				return;
			} catch {
				// settings.json not readable yet (R2 not mounted) — tell client to retry
			}
		}

		// Workspace not ready — return 503 so client retries
		res.writeHead(503, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Workspace not ready" }));
	}

	/** Handle GET /api/files — directory listing */
	private handleFilesApi(req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const requestedPath = url.searchParams.get("path") || "";

		// Resolve and validate path is within workspace
		const fullPath = resolve(this.workspaceDir, requestedPath);
		if (!fullPath.startsWith(this.workspaceDir)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside workspace" }));
			return;
		}

		try {
			const stat = statSync(fullPath);
			if (!stat.isDirectory()) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Not a directory" }));
				return;
			}

			const entries = readdirSync(fullPath, { withFileTypes: true });
			const files = entries.map((entry) => {
				const entryPath = join(requestedPath, entry.name);
				const entryFullPath = join(fullPath, entry.name);
				const isDir = entry.isDirectory();
				const result: Record<string, unknown> = {
					name: entry.name,
					path: entryPath,
					type: isDir ? "directory" : "file",
				};
				if (!isDir) {
					try {
						const s = statSync(entryFullPath);
						result.size = s.size;
						result.modified = s.mtime.toISOString();
					} catch {
						// Skip stat errors
					}
				}
				return result;
			});

			// Sort: directories first, then alphabetical
			files.sort((a, b) => {
				if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
				return (a.name as string).localeCompare(b.name as string);
			});

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ files }));
		} catch {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Directory not found" }));
		}
	}

	/** Handle GET /api/file — read file contents */
	private handleFileApi(req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const requestedPath = url.searchParams.get("path") || "";

		if (!requestedPath) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing path parameter" }));
			return;
		}

		const fullPath = resolve(this.workspaceDir, requestedPath);
		if (!fullPath.startsWith(this.workspaceDir)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside workspace" }));
			return;
		}

		try {
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Path is a directory, use /api/files" }));
				return;
			}

			// Don't serve huge files
			if (stat.size > 5 * 1024 * 1024) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "File too large (>5MB)" }));
				return;
			}

			const content = readFileSync(fullPath, "utf-8");
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(content);
		} catch {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "File not found" }));
		}
	}

	/** Handle GET /awareness/stream — SSE endpoint that tails context.jsonl */
	private handleAwarenessStream(_req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500);
			res.end("No workspace configured");
			return;
		}

		const contextFile = resolve(this.workspaceDir, "awareness/context.jsonl");

		// SSE headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		});

		// Send backlog — every existing line as an event
		let currentSize = 0;
		try {
			const content = readFileSync(contextFile, "utf-8");
			currentSize = Buffer.byteLength(content, "utf-8");
			const lines = content.split("\n").filter(Boolean);
			for (const line of lines) {
				res.write(`data: ${line}\n\n`);
			}
		} catch {
			// File doesn't exist yet — that's OK, we'll pick it up when it's created
		}

		// Track this client's file offset
		let clientOffset = currentSize;

		// Register client
		this.awarenessClients.add(res);

		// Start the shared file watcher if not already running
		if (!this.awarenessWatcher) {
			this.awarenessFileSize = currentSize;
			this.startAwarenessWatcher(contextFile);
		}

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			try { res.write(": heartbeat\n\n"); } catch { /* client gone */ }
		}, 15000);

		// Clean up on disconnect
		res.on("close", () => {
			clearInterval(heartbeat);
			this.awarenessClients.delete(res);
			if (this.awarenessClients.size === 0 && this.awarenessWatcher) {
				clearInterval(this.awarenessWatcher);
				this.awarenessWatcher = null;
			}
		});
	}

	/** Poll context.jsonl for new bytes and push to all connected SSE clients */
	private startAwarenessWatcher(contextFile: string): void {
		this.awarenessWatcher = setInterval(() => {
			try {
				const stat = statSync(contextFile);
				const newSize = stat.size;
				if (newSize <= this.awarenessFileSize) return;

				// Read only the new bytes
				const fd = openSync(contextFile, "r");
				const buf = Buffer.alloc(newSize - this.awarenessFileSize);
				readSync(fd, buf, 0, buf.length, this.awarenessFileSize);
				closeSync(fd);

				this.awarenessFileSize = newSize;

				const newContent = buf.toString("utf-8");
				const lines = newContent.split("\n").filter(Boolean);

				for (const line of lines) {
					const event = `data: ${line}\n\n`;
					for (const client of this.awarenessClients) {
						try { client.write(event); } catch { /* client gone, will be cleaned up */ }
					}
				}
			} catch {
				// File gone or read error — skip this tick
			}
		}, 500);
	}

	/** Start listening on the given port */
	async start(port: number): Promise<void> {
		this.server = createServer((req, res) => {
			const rawUrl = req.url || "/";
			const urlPath = rawUrl.split("?")[0];

			// Health check — no auth
			if (req.method === "GET" && urlPath === "/health") {
				res.writeHead(200);
				res.end("ok");
				return;
			}

			// Registered GET routes (status, schedule) — no auth
			if (req.method === "GET") {
				const getHandler = this.getRoutes.get(rawUrl) || this.getRoutes.get(urlPath);
				if (getHandler) {
					getHandler(req, res);
					return;
				}
			}

			// Config API
			if (req.method === "GET" && urlPath === "/api/config") {
				this.handleConfigApi(req, res);
				return;
			}

			// File API routes
			if (req.method === "GET" && urlPath === "/api/files") {
				this.handleFilesApi(req, res);
				return;
			}

			if (req.method === "GET" && urlPath === "/api/file") {
				this.handleFileApi(req, res);
				return;
			}

			// Awareness stream — SSE endpoint
			if (req.method === "GET" && urlPath === "/awareness/stream") {
				this.handleAwarenessStream(req, res);
				return;
			}

			// Static UI serving
			if (req.method === "GET" && this.uiDir) {

				// Serve assets directly
				if (urlPath.startsWith("/assets/")) {
					const filePath = join(this.uiDir, urlPath);
					const normalized = normalize(filePath);
					if (normalized.startsWith(this.uiDir)) {
						this.serveStatic(normalized, res);
						return;
					}
				}

				// SPA fallback: any non-API, non-webhook GET → index.html
				const indexPath = join(this.uiDir, "index.html");
				if (existsSync(indexPath)) {
					this.serveStatic(indexPath, res);
					return;
				}
			}

			// POST routes — webhook adapters (adapter-specific auth, no web token check)
			if (req.method === "POST") {
				const handler = this.routes.get(urlPath);
				if (!handler) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				if (!this.readyRoutes.has(urlPath)) {
					res.writeHead(503);
					res.end("Adapter not ready");
					return;
				}

				handler(req, res);
				return;
			}

			// Nothing matched
			if (req.method === "GET") {
				res.writeHead(404);
				res.end("Not found");
			} else {
				res.writeHead(405);
				res.end("Method not allowed");
			}
		});

		await new Promise<void>((resolve) => {
			this.server!.listen(port, () => {
				log.logInfo(`[gateway] listening on port ${port} (${this.routes.size} POST + ${this.getRoutes.size} GET routes${this.uiDir ? " + UI" : ""})`);
				resolve();
			});
		});
	}

	/** Stop the server */
	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
			this.server = null;
		}
	}
}
