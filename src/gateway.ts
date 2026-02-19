import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import * as log from "./log.js";

/**
 * Gateway — single HTTP server with path-based routing.
 * Replaces per-adapter HTTP servers with one shared server.
 */

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class Gateway {
	private routes = new Map<string, RouteHandler>();
	private getRoutes = new Map<string, RouteHandler>();
	private readyRoutes = new Set<string>();
	private server: Server | null = null;

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

	/** Start listening on the given port */
	async start(port: number): Promise<void> {
		this.server = createServer((req, res) => {
			// Health check
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200);
				res.end("ok");
				return;
			}

			// GET routes (no readiness gate — always available)
			if (req.method === "GET") {
				const getHandler = this.getRoutes.get(req.url || "");
				if (getHandler) {
					getHandler(req, res);
					return;
				}
			}

			if (req.method !== "POST") {
				res.writeHead(405);
				res.end("Method not allowed");
				return;
			}

			const handler = this.routes.get(req.url || "");
			if (!handler) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			if (!this.readyRoutes.has(req.url || "")) {
				res.writeHead(503);
				res.end("Adapter not ready");
				return;
			}

			handler(req, res);
		});

		await new Promise<void>((resolve) => {
			this.server!.listen(port, () => {
				log.logInfo(`[gateway] listening on port ${port} (${this.routes.size} POST + ${this.getRoutes.size} GET routes)`);
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
