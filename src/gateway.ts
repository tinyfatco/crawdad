import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
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
	/** Token required for UI and file API access (skipped for webhook routes) */
	webToken?: string;
}

export class Gateway {
	private routes = new Map<string, RouteHandler>();
	private getRoutes = new Map<string, RouteHandler>();
	private readyRoutes = new Set<string>();
	private server: Server | null = null;
	private uiDir: string | null = null;
	private workspaceDir: string | null = null;
	private webToken: string | null = null;

	constructor(options: GatewayOptions = {}) {
		if (options.uiDir && existsSync(options.uiDir)) {
			this.uiDir = resolve(options.uiDir);
			log.logInfo(`[gateway] serving UI from ${this.uiDir}`);
		}
		if (options.workspaceDir) {
			this.workspaceDir = resolve(options.workspaceDir);
		}
		this.webToken = options.webToken || null;
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

	/** Check WEB_TOKEN auth. Returns true if authorized, false if rejected (response already sent). */
	private checkWebAuth(req: IncomingMessage, res: ServerResponse): boolean {
		if (!this.webToken) return true;

		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const tokenParam = url.searchParams.get("token");
		const authHeader = req.headers.authorization;
		const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

		if (tokenParam === this.webToken || bearerToken === this.webToken) {
			return true;
		}

		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return false;
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

			// File API routes — require web auth
			if (req.method === "GET" && urlPath === "/api/files") {
				if (!this.checkWebAuth(req, res)) return;
				this.handleFilesApi(req, res);
				return;
			}

			if (req.method === "GET" && urlPath === "/api/file") {
				if (!this.checkWebAuth(req, res)) return;
				this.handleFileApi(req, res);
				return;
			}

			// Static UI serving — require web auth
			if (req.method === "GET" && this.uiDir) {
				if (!this.checkWebAuth(req, res)) return;

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
