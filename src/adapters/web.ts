import { appendFileSync, existsSync, mkdirSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// WebAdapter — HTTP POST with SSE response (for web chat)
// ============================================================================

/**
 * Inbound web chat message from crawdad-cf.
 * crawdad-cf translates browser WebSocket messages to this format.
 */
interface WebChatPayload {
	message: string;
	channelId?: string;
}

export interface WebAdapterConfig {
	workingDir: string;
}

/**
 * SSE writer — sends events to the HTTP response as Server-Sent Events.
 */
class SSEWriter {
	private res: ServerResponse;
	private closed = false;

	constructor(res: ServerResponse) {
		this.res = res;
	}

	send(event: Record<string, unknown>): void {
		if (this.closed) return;
		try {
			this.res.write(`data: ${JSON.stringify(event)}\n\n`);
		} catch {
			this.closed = true;
		}
	}

	done(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.res.write("data: [DONE]\n\n");
			this.res.end();
		} catch {
			// Already closed
		}
	}
}

export class WebAdapter implements PlatformAdapter {
	readonly name = "web";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Web Chat Formatting (Markdown)
You are responding via web chat. Use standard Markdown formatting.
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Keep responses concise and helpful.`;

	private workingDir: string;
	private handler!: MomHandler;
	/** Per-channel SSE writer — set in dispatch, read in createContext */
	private pendingWriters = new Map<string, SSEWriter>();

	constructor(config: WebAdapterConfig) {
		this.workingDir = config.workingDir;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("WebAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("Web chat adapter ready");
		log.logConnected();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf-8");

			let payload: WebChatPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			if (!payload.message || typeof payload.message !== "string" || !payload.message.trim()) {
				res.writeHead(400);
				res.end("Missing required field: message");
				return;
			}

			// Set up SSE response headers — keep connection open for streaming
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});

			const writer = new SSEWriter(res);

			this.processMessage(payload, writer).catch((err) => {
				log.logWarning("Web chat processing error", err instanceof Error ? err.message : String(err));
				writer.send({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
				writer.done();
			});
		});
	}

	// ==========================================================================
	// Message processing
	// ==========================================================================

	private async processMessage(payload: WebChatPayload, writer: SSEWriter): Promise<void> {
		const channelId = payload.channelId || "web";
		const ts = String(Date.now());

		log.logInfo(`[web] Inbound: ${payload.message.substring(0, 80)}`);

		const event: MomEvent = {
			type: "dm",
			channel: channelId,
			ts,
			user: "web-user",
			text: payload.message,
		};

		this.logToFile(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "web-user",
			userName: "web-user",
			text: event.text,
			attachments: [],
			isBot: false,
		});

		if (this.handler.isRunning(channelId)) {
			log.logInfo(`[web] Already running for ${channelId}`);
			writer.send({ type: "error", message: "Already processing a message, say stop to cancel" });
			writer.done();
			return;
		}

		// Stash writer so createContext can access it
		this.pendingWriters.set(channelId, writer);

		// Keep stream active during long tool/thinking phases to avoid idle SSE gaps.
		const keepalive = setInterval(() => {
			writer.send({ type: "heartbeat", ts: Date.now() });
		}, 12000);

		try {
			await this.handler.handleEvent(event, this);
		} finally {
			clearInterval(keepalive);
			this.pendingWriters.delete(channelId);
			writer.done();
		}
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops for web)
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

	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Metadata (web has no channels/users concept)
	// ==========================================================================

	getUser(_userId: string): UserInfo | undefined {
		return undefined;
	}

	getChannel(_channelId: string): ChannelInfo | undefined {
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [];
	}

	getAllChannels(): ChannelInfo[] {
		return [];
	}

	enqueueEvent(_event: MomEvent): boolean {
		return false;
	}

	// ==========================================================================
	// Context creation — streams SSE events back to the HTTP response
	//
	// The agent runner calls these methods during execution:
	// - respond("_→ Label_", false) → tool_start SSE event
	// - respond("_Error: ..._", false) → tool error
	// - respond(text, true) → token SSE event (response text)
	// - respondInThread(*✓ toolName*...) → tool_end SSE event
	// - setWorking(false) → run_complete SSE event
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		const writer = this.pendingWriters.get(event.channel);
		let lastToolId: string | undefined;

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "web-user",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: undefined,
			channels: [],
			users: [],

			respond: async (text: string, shouldLog = true) => {
				if (!writer) return;

				// Tool labels: _→ Label_
				if (!shouldLog && text.startsWith("_→")) {
					const label = text.replace(/^_→\s*/, "").replace(/_$/, "");
					lastToolId = `tool-${Date.now()}`;
					writer.send({
						type: "tool_start",
						toolCallId: lastToolId,
						toolName: label,
					});
					return;
				}

				// Status messages: _Thinking..._, _Compacting..._, _Retrying..._
				if (!shouldLog && text.startsWith("_") && text.endsWith("_")) {
					return;
				}

				// Tool error messages
				if (!shouldLog && text.startsWith("_Error:")) {
					if (lastToolId) {
						writer.send({
							type: "tool_end",
							toolCallId: lastToolId,
							isError: true,
							resultPreview: text.replace(/^_Error:\s*/, "").replace(/_$/, ""),
						});
						lastToolId = undefined;
					}
					return;
				}

				// Response text → token event
				if (shouldLog && text.trim()) {
					writer.send({ type: "token", text });
				}
			},

			replaceMessage: async (text: string) => {
				// Final text — already sent via respond(), no need to re-send
			},

			respondInThread: async (text: string) => {
				if (!writer) return;

				// Tool result messages: *✓ toolName*: label (1.2s)
				const toolMatch = text.match(/^\*([✓✗]) (\w+)\*(?:: (.+?))? \((\d+\.\d+)s\)/);
				if (toolMatch) {
					const [, status, toolName] = toolMatch;
					const resultMatch = text.match(/\*Result:\*\n```\n([\s\S]*?)\n```/);
					const preview = resultMatch ? resultMatch[1] : undefined;

					writer.send({
						type: "tool_end",
						toolCallId: lastToolId,
						toolName,
						isError: status === "✗",
						resultPreview: preview,
					});
					lastToolId = undefined;
				}
				// Other thread messages (thinking, usage summary) — skip
			},

			setTyping: async () => {},

			uploadFile: async () => {},

			setWorking: async (working: boolean) => {
				if (!working && writer) {
					writer.send({ type: "run_complete", channelId: event.channel });
				}
			},

			deleteMessage: async () => {},
		};
	}
}
