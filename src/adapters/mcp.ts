/**
 * MCP Adapter — exposes agent tools over MCP Streamable HTTP.
 *
 * Runs inside the container on the gateway's shared HTTP port (3002).
 * Auth is handled by crawdad-cf before proxying here.
 *
 * Uses the Node.js StreamableHTTPServerTransport (wraps Web Standard
 * transport internally via @hono/node-server).
 */

import { execSync } from "child_process";
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

	private exec(command: string): { stdout: string; stderr: string; code: number } {
		try {
			const stdout = execSync(command, {
				cwd: this.workingDir,
				timeout: 120_000,
				maxBuffer: 10 * 1024 * 1024,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}) as string;
			return { stdout, stderr: "", code: 0 };
		} catch (err: unknown) {
			const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
			return {
				stdout: e.stdout || "",
				stderr: e.stderr || e.message || "Command failed",
				code: e.status ?? 1,
			};
		}
	}

	private shellEscape(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}

	private registerTools(server: McpServer): void {
		// ── execute ──────────────────────────────────────────────────────
		server.registerTool(
			"bash",
			{
				description: "Run a shell command on your TinyFat computer. Returns stdout/stderr.",
				inputSchema: { command: z.string().describe("Shell command to execute") },
			},
			async ({ command }: { command: string }) => {
				log.logInfo(`[mcp] bash: ${command.substring(0, 100)}`);
				const result = this.exec(command);

				this.logToFile({
					date: new Date().toISOString(),
					channel: "mcp",
					type: "tool_call",
					tool: "bash",
					command,
					success: result.code === 0,
					...(result.code !== 0 && { exitCode: result.code }),
				});

				const output = result.code === 0
					? result.stdout || "(no output)"
					: [result.stdout, result.stderr].filter(Boolean).join("\n");

				return {
					content: [{ type: "text" as const, text: output }],
					...(result.code !== 0 && { isError: true }),
				};
			},
		);

		// ── read ─────────────────────────────────────────────────────────
		server.registerTool(
			"read",
			{
				description: "Read the contents of a file. Use offset/limit for large files.",
				inputSchema: {
					path: z.string().describe("Path to the file to read (relative or absolute)"),
					offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
					limit: z.number().optional().describe("Maximum number of lines to read"),
				},
			},
			async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
				log.logInfo(`[mcp] read: ${path}`);
				const escaped = this.shellEscape(path);

				// Get total lines
				const countResult = this.exec(`wc -l < ${escaped}`);
				if (countResult.code !== 0) {
					return { content: [{ type: "text" as const, text: countResult.stderr }], isError: true };
				}
				const totalLines = parseInt(countResult.stdout.trim(), 10) + 1;

				const startLine = offset ? Math.max(1, offset) : 1;
				if (startLine > totalLines) {
					return { content: [{ type: "text" as const, text: `Offset ${offset} is beyond end of file (${totalLines} lines)` }], isError: true };
				}

				let cmd = startLine === 1 ? `cat ${escaped}` : `tail -n +${startLine} ${escaped}`;
				if (limit) {
					cmd += ` | head -n ${limit}`;
				}

				const result = this.exec(cmd);
				if (result.code !== 0) {
					return { content: [{ type: "text" as const, text: result.stderr }], isError: true };
				}

				const readLines = result.stdout.split("\n").length;
				const endLine = startLine + readLines - 1;
				let text = result.stdout;
				if (endLine < totalLines) {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue]`;
				}

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "read", path, success: true });
				return { content: [{ type: "text" as const, text }] };
			},
		);

		// ── write ────────────────────────────────────────────────────────
		server.registerTool(
			"write",
			{
				description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
				inputSchema: {
					path: z.string().describe("Path to the file to write (relative or absolute)"),
					content: z.string().describe("Content to write to the file"),
				},
			},
			async ({ path, content }: { path: string; content: string }) => {
				log.logInfo(`[mcp] write: ${path} (${content.length} bytes)`);
				const escaped = this.shellEscape(path);
				const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";

				const cmd = `mkdir -p ${this.shellEscape(dir)} && printf '%s' ${this.shellEscape(content)} > ${escaped}`;
				const result = this.exec(cmd);

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "write", path, success: result.code === 0 });

				if (result.code !== 0) {
					return { content: [{ type: "text" as const, text: result.stderr }], isError: true };
				}
				return { content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${path}` }] };
			},
		);

		// ── edit ─────────────────────────────────────────────────────────
		server.registerTool(
			"edit",
			{
				description: "Edit a file by replacing exact text. The old_text must match exactly one occurrence (including whitespace).",
				inputSchema: {
					path: z.string().describe("Path to the file to edit (relative or absolute)"),
					old_text: z.string().describe("Exact text to find and replace (must match exactly)"),
					new_text: z.string().describe("New text to replace the old text with"),
				},
			},
			async ({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
				log.logInfo(`[mcp] edit: ${path}`);
				const escaped = this.shellEscape(path);

				// Read file
				const readResult = this.exec(`cat ${escaped}`);
				if (readResult.code !== 0) {
					return { content: [{ type: "text" as const, text: `File not found: ${path}` }], isError: true };
				}

				const fileContent = readResult.stdout;

				if (!fileContent.includes(old_text)) {
					return { content: [{ type: "text" as const, text: `Could not find the exact text in ${path}. Must match exactly including whitespace.` }], isError: true };
				}

				const occurrences = fileContent.split(old_text).length - 1;
				if (occurrences > 1) {
					return { content: [{ type: "text" as const, text: `Found ${occurrences} occurrences in ${path}. Must be unique — provide more context.` }], isError: true };
				}

				const idx = fileContent.indexOf(old_text);
				const newContent = fileContent.substring(0, idx) + new_text + fileContent.substring(idx + old_text.length);

				const writeResult = this.exec(`printf '%s' ${this.shellEscape(newContent)} > ${escaped}`);
				if (writeResult.code !== 0) {
					return { content: [{ type: "text" as const, text: writeResult.stderr }], isError: true };
				}

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "edit", path, success: true });
				return { content: [{ type: "text" as const, text: `Replaced ${old_text.length} chars with ${new_text.length} chars in ${path}` }] };
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
