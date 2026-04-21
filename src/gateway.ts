import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { Socket } from "net";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, watch, type FSWatcher } from "fs";
import { join, extname, resolve, normalize, dirname } from "path";
import * as log from "./log.js";
import { awarenessBus } from "./awareness-bus.js";

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

export type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void;

export class Gateway {
	private routes = new Map<string, RouteHandler>();
	private getRoutes = new Map<string, RouteHandler>();
	private upgradeRoutes = new Map<string, UpgradeHandler>();
	private readyRoutes = new Set<string>();
	private server: Server | null = null;
	private uiDir: string | null = null;
	private workspaceDir: string | null = null;
	/** Connected SSE clients for /awareness/stream */
	private awarenessClients = new Set<ServerResponse>();
	/** fs.watch backstop for writes not routed through awarenessBus (e.g. pi-coding-agent SessionManager) */
	private awarenessWatcher: FSWatcher | null = null;
	private awarenessFileSize = 0;
	/** Unsubscribe function for the in-process bus listener */
	private awarenessBusUnsub: (() => void) | null = null;

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

	/** Register a WebSocket upgrade handler (e.g., "/voice/stream") */
	registerUpgrade(path: string, handler: UpgradeHandler): void {
		this.upgradeRoutes.set(path, handler);
		log.logInfo(`[gateway] registered route: UPGRADE ${path}`);
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

	/** Handle POST /api/file/save — write file contents */
	private handleFileSaveApi(req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const chunks: Buffer[] = [];
		let totalSize = 0;
		const MAX_SIZE = 5 * 1024 * 1024;

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_SIZE) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "File too large (>5MB)" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (totalSize > MAX_SIZE) return;

			let payload: { path?: string; content?: string };
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON" }));
				return;
			}

			if (!payload.path || typeof payload.content !== "string") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing path or content" }));
				return;
			}

			const fullPath = resolve(this.workspaceDir!, payload.path);
			if (!fullPath.startsWith(this.workspaceDir!)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Path outside workspace" }));
				return;
			}

			try {
				const dir = dirname(fullPath);
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				writeFileSync(fullPath, payload.content, "utf-8");
				log.logInfo(`[save] wrote ${payload.path} (${payload.content.length} bytes)`);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				log.logWarning("[save] write error", err instanceof Error ? err.message : String(err));
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Failed to write file" }));
			}
		});
	}

	/** Handle POST /api/upload — multipart file upload to workspace */
	private handleUploadApi(req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const contentType = req.headers["content-type"] || "";
		const boundaryMatch = contentType.match(/boundary=(.+)/);
		if (!boundaryMatch) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing multipart boundary" }));
			return;
		}

		const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB total
		const chunks: Buffer[] = [];
		let totalSize = 0;

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_UPLOAD) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Upload too large (50MB max)" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (totalSize > MAX_UPLOAD) return; // already responded

			const body = Buffer.concat(chunks);
			const boundary = boundaryMatch![1];
			const uploaded: string[] = [];

			try {
				const files = parseMultipart(body, boundary);

				// Extract target directory from form fields
				let targetDir = "attachments";
				for (const file of files) {
					if (file.name === "targetDir" && !file.filename) {
						targetDir = file.data.toString("utf-8").trim() || "attachments";
						continue;
					}
					if (!file.filename) continue;

					// Sanitize filename — strip path separators, collapse dots
					const safeName = file.filename.replace(/[/\\]/g, "_").replace(/\.{2,}/g, ".");
					if (!safeName) continue;

					const relPath = join(targetDir, safeName);
					const fullPath = resolve(this.workspaceDir!, relPath);

					// Path traversal check
					if (!fullPath.startsWith(this.workspaceDir!)) {
						log.logWarning("[upload] path traversal attempt blocked", relPath);
						continue;
					}

					// Ensure directory exists
					const dir = dirname(fullPath);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
					}

					writeFileSync(fullPath, file.data);
					uploaded.push(relPath);
					log.logInfo(`[upload] wrote ${relPath} (${file.data.length} bytes)`);
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ uploaded }));
			} catch (err) {
				log.logWarning("[upload] parse error", err instanceof Error ? err.message : String(err));
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Failed to parse upload" }));
			}
		});
	}

	/** Handle GET /awareness/backlog — returns last N lines of context.jsonl as JSON array */
	private handleAwarenessBacklog(req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const contextFile = resolve(this.workspaceDir, "awareness/context.jsonl");
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
		const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;

		let allLines: string[];
		try {
			const content = readFileSync(contextFile, "utf-8");
			allLines = content.split("\n").filter(Boolean);
		} catch {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ lines: [], total: 0, offset: 0 }));
			return;
		}

		const total = allLines.length;
		// "before" is a line index — return `limit` lines ending before that index
		// If before=0 (default), return the last `limit` lines
		const endIndex = before > 0 ? Math.min(before, total) : total;
		const startIndex = Math.max(0, endIndex - limit);
		const slice = allLines.slice(startIndex, endIndex);

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ lines: slice, total, offset: startIndex }));
	}

	/** Handle GET /awareness/stream — SSE endpoint driven by awarenessBus + fs.watch backstop */
	private handleAwarenessStream(_req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500);
			res.end("No workspace configured");
			return;
		}

		const contextFile = resolve(this.workspaceDir, "awareness/context.jsonl");

		// SSE headers — flush immediately so clients see the stream open
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		if (typeof (res as any).flushHeaders === "function") {
			try { (res as any).flushHeaders(); } catch { /* noop */ }
		}

		// Record current file size so the fs.watch backstop only emits new lines
		let currentSize = 0;
		try {
			const stat = statSync(contextFile);
			currentSize = stat.size;
		} catch {
			// File doesn't exist yet
		}

		this.awarenessClients.add(res);

		// Start shared subscriptions if this is the first client
		if (this.awarenessClients.size === 1) {
			this.awarenessFileSize = currentSize;
			this.startAwarenessSubscriptions(contextFile);
		}

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			try { res.write(": heartbeat\n\n"); } catch { /* client gone */ }
		}, 15000);

		res.on("close", () => {
			clearInterval(heartbeat);
			this.awarenessClients.delete(res);
			if (this.awarenessClients.size === 0) {
				this.stopAwarenessSubscriptions();
			}
		});
	}

	/**
	 * Start the shared in-process bus subscription and fs.watch backstop.
	 * - awarenessBus: near-zero-latency path for writes routed through the bus
	 *   (commands.ts, presence.ts, adapters/operator.ts, web chat)
	 * - fs.watch: OS-push backstop for writes we don't control (pi-coding-agent's
	 *   SessionManager). Reads delta bytes, emits them to clients.
	 *
	 * Both paths write directly to this.awarenessClients; duplicates are avoided
	 * because fs.watch updates this.awarenessFileSize whenever it emits a line,
	 * and the bus path also advances the file size (since it was written to disk
	 * moments earlier). In practice the bus fires first and fs.watch finds no
	 * new bytes.
	 */
	private startAwarenessSubscriptions(contextFile: string): void {
		// In-process bus
		this.awarenessBusUnsub = awarenessBus.subscribe((line) => {
			// Advance size tracker so fs.watch doesn't re-emit the same line
			try {
				const stat = statSync(contextFile);
				this.awarenessFileSize = stat.size;
			} catch { /* file may not exist yet */ }
			this.emitAwarenessLine(line);
		});

		// fs.watch backstop for uncaptured writers
		try {
			this.awarenessWatcher = watch(contextFile, { persistent: false }, () => {
				this.drainAwarenessFile(contextFile);
			});
		} catch {
			// File may not exist yet — retry once the watcher fires on parent dir,
			// or rely solely on the bus. For the SSE-through-SessionManager case
			// we need this so try once more after a short delay.
			setTimeout(() => {
				try {
					this.awarenessWatcher = watch(contextFile, { persistent: false }, () => {
						this.drainAwarenessFile(contextFile);
					});
				} catch { /* give up */ }
			}, 500);
		}
	}

	private stopAwarenessSubscriptions(): void {
		if (this.awarenessBusUnsub) {
			this.awarenessBusUnsub();
			this.awarenessBusUnsub = null;
		}
		if (this.awarenessWatcher) {
			this.awarenessWatcher.close();
			this.awarenessWatcher = null;
		}
	}

	/** Read newly-appended bytes and emit each line to all clients */
	private drainAwarenessFile(contextFile: string): void {
		try {
			const stat = statSync(contextFile);
			const newSize = stat.size;
			if (newSize <= this.awarenessFileSize) return;

			const fd = openSync(contextFile, "r");
			const buf = Buffer.alloc(newSize - this.awarenessFileSize);
			readSync(fd, buf, 0, buf.length, this.awarenessFileSize);
			closeSync(fd);

			this.awarenessFileSize = newSize;

			const lines = buf.toString("utf-8").split("\n").filter(Boolean);
			for (const line of lines) {
				this.emitAwarenessLine(line);
			}
		} catch {
			// Read error — skip
		}
	}

	private emitAwarenessLine(line: string): void {
		const event = `data: ${line}\n\n`;
		for (const client of this.awarenessClients) {
			try { client.write(event); } catch { /* client gone, cleaned on close */ }
		}
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

			// Awareness backlog — paginated recent entries
			if (req.method === "GET" && urlPath === "/awareness/backlog") {
				this.handleAwarenessBacklog(req, res);
				return;
			}

			// Awareness stream — SSE endpoint (live updates only, no backlog)
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

			// File save API
			if (req.method === "POST" && urlPath === "/api/file/save") {
				this.handleFileSaveApi(req, res);
				return;
			}

			// File upload API
			if (req.method === "POST" && urlPath === "/api/upload") {
				this.handleUploadApi(req, res);
				return;
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
					log.logInfo(`[gateway] POST ${urlPath} → 503 (not ready)`);
					res.writeHead(503);
					res.end("Adapter not ready");
					return;
				}

				log.logInfo(`[gateway] POST ${urlPath} received at ${new Date().toISOString()}`);
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

		// Handle WebSocket upgrades
		this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
			const urlPath = (req.url || "").split("?")[0];
			const handler = this.upgradeRoutes.get(urlPath);
			if (handler) {
				handler(req, socket, head);
			} else {
				socket.destroy();
			}
		});

		await new Promise<void>((resolve) => {
			this.server!.listen(port, () => {
				log.logInfo(`[gateway] listening on port ${port} (${this.routes.size} POST + ${this.getRoutes.size} GET + ${this.upgradeRoutes.size} UPGRADE routes${this.uiDir ? " + UI" : ""})`);
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

// =============================================================================
// Multipart form-data parser (no dependencies)
// =============================================================================

interface MultipartFile {
	name: string;
	filename?: string;
	contentType?: string;
	data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartFile[] {
	const files: MultipartFile[] = [];
	const delimBuf = Buffer.from(`--${boundary}`);
	const endBuf = Buffer.from(`--${boundary}--`);
	const crlfcrlf = Buffer.from("\r\n\r\n");

	let pos = 0;
	while (pos < body.length) {
		const partStart = bufferIndexOf(body, delimBuf, pos);
		if (partStart === -1) break;

		const afterDelim = partStart + delimBuf.length;
		// Check for final boundary
		if (body.slice(afterDelim, afterDelim + 2).toString() === "--") break;

		const headerStart = afterDelim + 2; // skip \r\n after boundary
		const headerEnd = bufferIndexOf(body, crlfcrlf, headerStart);
		if (headerEnd === -1) break;

		const headers = body.slice(headerStart, headerEnd).toString("utf-8");
		const dataStart = headerEnd + 4; // skip \r\n\r\n

		// Find next boundary to determine data end
		const nextBoundary = bufferIndexOf(body, delimBuf, dataStart);
		const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // -2 for \r\n before boundary

		const data = body.slice(dataStart, dataEnd);

		// Parse headers
		const nameMatch = headers.match(/name="([^"]+)"/);
		const filenameMatch = headers.match(/filename="([^"]+)"/);
		const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

		if (nameMatch) {
			files.push({
				name: nameMatch[1],
				filename: filenameMatch?.[1],
				contentType: ctMatch?.[1]?.trim(),
				data,
			});
		}

		pos = nextBoundary === -1 ? body.length : nextBoundary;
	}

	return files;
}

function bufferIndexOf(buf: Buffer, search: Buffer, fromIndex: number): number {
	for (let i = fromIndex; i <= buf.length - search.length; i++) {
		let found = true;
		for (let j = 0; j < search.length; j++) {
			if (buf[i + j] !== search[j]) {
				found = false;
				break;
			}
		}
		if (found) return i;
	}
	return -1;
}
