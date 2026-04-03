/**
 * MCP Adapter — exposes agent tools over MCP Streamable HTTP.
 *
 * Runs inside the container on the gateway's shared HTTP port (3002).
 * Auth is handled by crawdad-cf before proxying here.
 *
 * Uses the Node.js StreamableHTTPServerTransport (wraps Web Standard
 * transport internally via @hono/node-server).
 */

import { appendFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	UserInfo,
} from "./types.js";

export interface McpAdapterConfig {
	workingDir: string;
}

export class McpAdapter implements PlatformAdapter {
	readonly name = "mcp";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `You are responding via MCP (Model Context Protocol). Return plain text results. Be concise and precise.`;

	private workingDir: string;
	private handler!: MomHandler;

	constructor(config: McpAdapterConfig) {
		this.workingDir = config.workingDir;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("McpAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("MCP adapter ready");
	}

	async stop(): Promise<void> {}

	/**
	 * Handle inbound MCP request — called by Gateway for POST /mcp.
	 * Creates a fresh stateless MCP server per request.
	 */
	dispatch(req: IncomingMessage, res: ServerResponse): void {
		this.handleMcpRequest(req, res).catch((err) => {
			log.logWarning("MCP request error", err instanceof Error ? err.message : String(err));
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
			}
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32603, message: "Internal error" },
				id: null,
			}));
		});
	}

	private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const server = new McpServer(
			{ name: "tinyfat-computer", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);

		this.registerTools(server);

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // Stateless
			enableJsonResponse: true,
		});

		await server.connect(transport);

		try {
			await transport.handleRequest(req, res);
		} finally {
			await transport.close().catch(() => {});
			await server.close().catch(() => {});
		}
	}

	private registerTools(server: McpServer): void {
		server.registerTool(
			"execute",
			{
				description: "Run a shell command on your TinyFat computer. Returns stdout/stderr.",
				inputSchema: { command: z.string().describe("Shell command to execute") },
			},
			async ({ command }: { command: string }) => {
				log.logInfo(`[mcp] execute: ${command.substring(0, 100)}`);

				try {
					const { execSync } = await import("child_process");
					const output = execSync(command, {
						cwd: this.workingDir,
						timeout: 120_000,
						maxBuffer: 10 * 1024 * 1024,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});

					this.logToFile({
						date: new Date().toISOString(),
						channel: "mcp",
						type: "tool_call",
						tool: "execute",
						command,
						success: true,
					});

					return {
						content: [{ type: "text" as const, text: output || "(no output)" }],
					};
				} catch (err: unknown) {
					const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
					const output = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n") || execErr.message || "Command failed";

					this.logToFile({
						date: new Date().toISOString(),
						channel: "mcp",
						type: "tool_call",
						tool: "execute",
						command,
						success: false,
						exitCode: execErr.status,
					});

					return {
						content: [{ type: "text" as const, text: output }],
						isError: true,
					};
				}
			},
		);
	}

	// ==========================================================================
	// PlatformAdapter — message operations (no-ops for MCP)
	// ==========================================================================

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(_channel: string, _text: string, _ts: string): void {}

	// ==========================================================================
	// Metadata (MCP has no channels/users)
	// ==========================================================================

	getUser(_userId: string): UserInfo | undefined { return undefined; }
	getChannel(_channelId: string): ChannelInfo | undefined { return undefined; }
	getAllUsers(): UserInfo[] { return []; }
	getAllChannels(): ChannelInfo[] { return []; }
	enqueueEvent(_event: MomEvent): boolean { return false; }

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "mcp-client",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: undefined,
			channels: [],
			users: [],
			respond: async () => {},
			sendFinalResponse: async () => {},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			restartWorking: async () => {},
		};
	}
}
