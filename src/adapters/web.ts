import { appendFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// WebAdapter — POST-and-go (no SSE).
//
// The browser POSTs a message. We enqueue it into the handler and return 200
// immediately. The agent's response flows through the awareness stream
// (awareness/context.jsonl + awarenessBus), which the browser is already
// subscribed to via GET /awareness/stream.
//
// This replaces an earlier design where web chat opened its own SSE response
// carrying token-level deltas. That path double-framed the same tokens (once
// here, once from the awareness stream), re-framed them again at the Worker,
// and relied on a 500ms file poll. Now: one writer, one stream, no surprises.
// ============================================================================

interface WebChatPayload {
	message: string;
	channelId?: string;
}

export interface WebAdapterConfig {
	workingDir: string;
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
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON" }));
				return;
			}

			if (!payload.message || typeof payload.message !== "string" || !payload.message.trim()) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing required field: message" }));
				return;
			}

			const channelId = payload.channelId || "web";
			const ts = String(Date.now());

			if (this.handler.isRunning(channelId)) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, status: "already_running" }));
				return;
			}

			const event: MomEvent = {
				type: "dm",
				channel: channelId,
				ts,
				user: "web-user",
				text: payload.message,
			};

			this.logToFile({
				date: new Date().toISOString(),
				ts,
				channel: `web:${channelId}`,
				channelId,
				user: "web-user",
				userName: "user",
				text: event.text,
				attachments: [],
				isBot: false,
			});

			// Fire-and-forget — response arrives via the awareness stream.
			// We ack the POST with 200 as soon as the event is accepted.
			this.handler.handleEvent(event, this).catch((err) => {
				log.logWarning("Web chat processing error", err instanceof Error ? err.message : String(err));
			});

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, status: "accepted", channelId, ts }));
		});
	}

	// ==========================================================================
	// PlatformAdapter — message operations (all no-ops for web)
	// Output is rendered from the awareness stream, not posted via platform API.
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

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `web:${channel}`,
			channelId: channel,
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
	// Context creation — everything is a no-op. The agent's output is written
	// through the runner → context.jsonl → awarenessBus, which is the only
	// surface the UI listens to.
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "user",
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
			emitContentBlock: () => {},
		};
	}
}
