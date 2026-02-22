import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// EmailWebhookAdapter — receives email via HTTP, runs agent, sends one reply
// ============================================================================

/**
 * Inbound email payload from the email inbound webhook → orchestrator → here.
 * Matches TriggerPayload from fat-agents/src/lib/email/inbound-types.ts
 */
interface EmailPayload {
	from: string;
	to: string;
	subject: string;
	body: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	allRecipients?: string[];
	emailChannel?: string | null;
	attachments?: Array<{
		filename: string;
		content_type: string;
		content: string; // base64
	}>;
}

export interface EmailWebhookAdapterConfig {
	workingDir: string;
	/** Agent's tools_token for authenticating against TinyFat API */
	toolsToken: string;
	/** URL for sending email replies (e.g., https://tinyfat.com/api/email/send) */
	sendUrl: string;
}

export class EmailWebhookAdapter implements PlatformAdapter {
	readonly name = "email";
	readonly maxMessageLength = 100000; // Email has no real limit
	readonly formatInstructions = `## Email Formatting (Markdown)
You are responding via email. Use standard Markdown formatting.
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Keep responses concise and professional. The user will receive one email with your complete response.`;

	private workingDir: string;
	private toolsToken: string;
	private sendUrl: string;
	private handler!: MomHandler;
	/** Per-channel email metadata for threading (set in processEmail, read in createContext) */
	private pendingPayloads = new Map<string, EmailPayload>();

	constructor(config: EmailWebhookAdapterConfig) {
		this.workingDir = config.workingDir;
		this.toolsToken = config.toolsToken;
		this.sendUrl = config.sendUrl;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("EmailWebhookAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("Email webhook adapter ready");
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

			let payload: EmailPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			if (!payload.from || !payload.body) {
				res.writeHead(400);
				res.end("Missing required fields: from, body");
				return;
			}

			// Acknowledge immediately — email processing can take a while
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));

			// Process email asynchronously
			this.processEmail(payload).catch((err) => {
				log.logWarning("Email processing error", err instanceof Error ? err.message : String(err));
			});
		});
	}

	// ==========================================================================
	// Email processing
	// ==========================================================================

	private async processEmail(payload: EmailPayload): Promise<void> {
		// Use a stable channel ID derived from the sender email
		// This groups all emails from the same sender into one conversation
		const channelId = `email-${payload.from.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
		const ts = String(Date.now());

		log.logInfo(`[email] Inbound from ${payload.from}: ${payload.subject || "(no subject)"}`);

		// Save attachments to disk so the agent can read them
		const savedPaths = this.saveAttachments(payload, channelId);

		const event: MomEvent = {
			type: "dm",
			channel: channelId,
			ts,
			user: payload.from,
			text: this.buildMessageText(payload, savedPaths),
		};

		// Store payload for createContext to read (threading metadata)
		this.pendingPayloads.set(channelId, payload);

		// Log the inbound message
		this.logToFile(channelId, {
			date: new Date().toISOString(),
			ts,
			user: payload.from,
			userName: payload.from.split("@")[0],
			text: event.text,
			attachments: [],
			isBot: false,
		});

		if (this.handler.isRunning(channelId)) {
			log.logInfo(`[email] Already running for ${channelId}, queuing`);
			this.enqueueEvent(event);
			return;
		}

		try {
			await this.handler.handleEvent(event, this);
		} finally {
			this.pendingPayloads.delete(channelId);
		}
	}

	private buildMessageText(payload: EmailPayload, savedPaths: Map<string, string>): string {
		const parts: string[] = [];

		if (payload.subject) {
			parts.push(`Subject: ${payload.subject}`);
		}

		parts.push(payload.body);

		if (savedPaths.size > 0) {
			const fileList = Array.from(savedPaths.entries())
				.map(([filename, path]) => `- ${filename}: ${path}`)
				.join("\n");
			parts.push(`Attachments saved to disk:\n${fileList}`);
		}

		return parts.join("\n\n");
	}

	private saveAttachments(payload: EmailPayload, channelId: string): Map<string, string> {
		const saved = new Map<string, string>();
		if (!payload.attachments || payload.attachments.length === 0) return saved;

		const dir = join(this.workingDir, channelId, "attachments");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		for (const att of payload.attachments) {
			try {
				const buffer = Buffer.from(att.content, "base64");
				const filePath = join(dir, att.filename);
				writeFileSync(filePath, buffer);
				saved.set(att.filename, filePath);
				log.logInfo(`[email] Saved attachment: ${att.filename} (${buffer.length} bytes) → ${filePath}`);
			} catch (err) {
				log.logWarning(`[email] Failed to save attachment ${att.filename}`, err instanceof Error ? err.message : String(err));
			}
		}

		return saved;
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops for email)
	// ==========================================================================

	async postMessage(channel: string, text: string, attachments?: Array<{ filePath: string; filename: string }>): Promise<string> {
		// Cross-channel send: channel format is "email-{address}"
		const emailMatch = channel.match(/^email-(.+)$/);
		if (!emailMatch) {
			throw new Error(`postMessage called with non-email channel: ${channel}`);
		}

		const toAddress = emailMatch[1];
		log.logInfo(`[email] Sending outbound to ${toAddress}${attachments?.length ? ` with ${attachments.length} attachment(s)` : ""}`);

		const emailMetadata = {
			to: toAddress,
			subject: "Message from your agent",
			body: text,
		};

		let response: Response;

		if (attachments && attachments.length > 0) {
			// Use multipart/form-data for emails with attachments
			log.logInfo(`[email] Using multipart for ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(", ")}`);

			const form = new FormData();
			form.append("metadata", JSON.stringify(emailMetadata));

			for (const att of attachments) {
				const buffer = readFileSync(att.filePath);
				form.append("attachments", new Blob([buffer]), att.filename);
				log.logInfo(`[email] Attached: ${att.filename} (${buffer.length} bytes)`);
			}

			response = await fetch(this.sendUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.toolsToken}`,
				},
				body: form,
			});
		} else {
			// No attachments — simple JSON
			response = await fetch(this.sendUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.toolsToken}`,
				},
				body: JSON.stringify(emailMetadata),
			});
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Email send failed (${response.status}): ${errorText}`);
		}

		const result = (await response.json()) as { ok: boolean; messageId?: string };
		log.logInfo(`[email] Outbound sent: messageId=${result.messageId}`);
		return result.messageId || String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
		// No-op
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// No-op
	}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		// No-op — thread messages go to tool log
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {
		// TODO: email attachments in future
	}

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
	// Metadata (email has no channels/users concept)
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

	enqueueEvent(event: MomEvent): boolean {
		// Email channel IDs start with "email-"
		if (!event.channel.startsWith("email-")) return false;

		if (this.handler.isRunning(event.channel)) {
			log.logInfo(`[email] Already running for ${event.channel}, discarding event`);
			return true; // Claim it so other adapters don't grab it
		}

		log.logInfo(`Enqueueing email event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.handler.handleEvent(event, this, true).catch((err) => {
			log.logWarning(`[email] Event handler error for ${event.channel}`, err instanceof Error ? err.message : String(err));
		});
		return true;
	}

	// ==========================================================================
	// Context creation — the key difference from Slack/Telegram
	//
	// Email context ACCUMULATES everything silently during the run.
	// On setWorking(false), it sends ONE email reply with:
	// - Agent's final text response
	// - Tool call log (concise labels + durations)
	// - Cost summary
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		const toolLog: string[] = [];
		const pendingAttachments: Array<{ filename: string; filePath: string }> = [];
		let finalText = "";
		const payload = this.pendingPayloads.get(event.channel);
		const emailMeta = {
			from: event.user,
			subject: payload?.subject || "(no subject)",
			messageId: payload?.messageId,
			inReplyTo: payload?.inReplyTo,
			references: payload?.references,
		};

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: event.user.split("@")[0],
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: undefined,
			channels: [],
			users: [],

			respond: async (text: string, shouldLog = true) => {
				// Tool labels come as _→ Label_ with shouldLog=false
				if (!shouldLog && text.startsWith("_→")) {
					const label = text.replace(/^_→\s*/, "").replace(/_$/, "");
					toolLog.push(`→ ${label}`);
					return;
				}

				if (!shouldLog && text.startsWith("_") && text.endsWith("_")) {
					// Status messages (Thinking, Compacting, Retrying) — log but don't include in response
					toolLog.push(text.replace(/^_/, "").replace(/_$/, ""));
					return;
				}

				if (!shouldLog && text.startsWith("_Error:")) {
					// Tool errors — add to log
					toolLog.push(text.replace(/^_/, "").replace(/_$/, ""));
					return;
				}

				// Actual response text
				if (shouldLog) {
					finalText = finalText ? `${finalText}\n${text}` : text;
				}
			},

			replaceMessage: async (text: string) => {
				finalText = text;
			},

			respondInThread: async (text: string) => {
				// Thread messages are tool results — add to log
				toolLog.push(text);
			},

			setTyping: async () => {
				// No-op for email
			},

			uploadFile: async (filePath: string, title?: string) => {
				try {
					const filename = title || basename(filePath);
					// Store the file path so sendEmailReply can read binary directly
					// (avoids base64-in-JSON overhead for multipart sends)
					pendingAttachments.push({ filename, filePath });
					const stat = readFileSync(filePath);
					log.logInfo(`[email] Queued attachment: ${filename} (${stat.length} bytes) from ${filePath}`);
				} catch (err) {
					log.logWarning(`[email] Failed to read attachment ${filePath}`, err instanceof Error ? err.message : String(err));
				}
			},

			setWorking: async (working: boolean) => {
				if (!working) {
					// Run complete — send the email reply
					await this.sendEmailReply(emailMeta, finalText, toolLog, pendingAttachments);
				}
			},

			deleteMessage: async () => {
				// No-op for email
			},
		};
	}

	// ==========================================================================
	// Email reply — the one outbound message
	// ==========================================================================

	private async sendEmailReply(
		meta: { from: string; subject: string; messageId?: string; inReplyTo?: string; references?: string },
		finalText: string,
		toolLog: string[],
		attachments: Array<{ filename: string; filePath: string }> = [],
	): Promise<void> {
		if (!finalText.trim()) {
			log.logInfo("[email] No response text to send");
			return;
		}

		// Build the concise work log
		const conciseLog = this.buildConciseLog(toolLog);

		const replySubject = meta.subject.startsWith("Re:") ? meta.subject : `Re: ${meta.subject}`;

		const emailMetadata: Record<string, unknown> = {
			to: meta.from,
			subject: replySubject,
			body: finalText,
		};

		// Add log as inline content if present
		if (conciseLog) {
			emailMetadata.log = "inline";
			emailMetadata.log_content = conciseLog;
		}

		// Add threading headers (reply to the original message)
		if (meta.messageId) {
			emailMetadata.in_reply_to = meta.messageId;
			emailMetadata.references = meta.references
				? `${meta.references} ${meta.messageId}`
				: meta.messageId;
		}

		log.logInfo(`[email] Sending reply to ${meta.from}: ${replySubject}`);

		try {
			let response: Response;

			if (attachments.length > 0) {
				// Use multipart/form-data for emails with attachments
				// Sends binary files directly — no base64-in-JSON overhead
				log.logInfo(`[email] Using multipart for ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(", ")}`);

				const form = new FormData();
				form.append("metadata", JSON.stringify(emailMetadata));

				for (const att of attachments) {
					const buffer = readFileSync(att.filePath);
					form.append("attachments", new Blob([buffer]), att.filename);
				}

				response = await fetch(this.sendUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.toolsToken}`,
						// Let fetch set Content-Type with boundary automatically
					},
					body: form,
				});
			} else {
				// No attachments — use simple JSON (existing path)
				response = await fetch(this.sendUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.toolsToken}`,
					},
					body: JSON.stringify(emailMetadata),
				});
			}

			if (!response.ok) {
				const errorText = await response.text();
				log.logWarning(`[email] Send failed: ${response.status}`, errorText);
			} else {
				const result = (await response.json()) as { ok: boolean; messageId?: string };
				log.logInfo(`[email] Reply sent: messageId=${result.messageId}`);
			}
		} catch (err) {
			log.logWarning("[email] Send error", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Build a concise work log from the accumulated tool log entries.
	 * Extracts just the tool labels and durations from the verbose thread messages.
	 */
	private buildConciseLog(toolLog: string[]): string {
		const lines: string[] = [];
		let toolCount = 0;

		for (const entry of toolLog) {
			// Tool start labels: "→ Reading file"
			if (entry.startsWith("→ ")) {
				lines.push(entry);
				toolCount++;
				continue;
			}

			// Tool result thread messages: "*✓ bash*: Running git status (1.2s)"
			// Extract just the summary line
			const toolMatch = entry.match(/^\*([✓✗]) (\w+)\*(?:: (.+?))? \((\d+\.\d+)s\)/);
			if (toolMatch) {
				const [, status, toolName, label, duration] = toolMatch;
				const displayLabel = label || toolName;
				lines.push(`${status === "✓" ? "→" : "✗"} ${displayLabel} (${duration}s)`);
				if (!entry.startsWith("→ ")) toolCount++;
				continue;
			}

			// Status messages (Thinking, Compacting, Retrying) — include as-is
			if (entry.startsWith("Thinking") || entry.startsWith("Compacting") || entry.startsWith("Retrying")) {
				lines.push(entry);
			}
		}

		if (lines.length === 0) return "";

		return `Work log:\n${lines.join("\n")}\n${toolCount} tool calls`;
	}
}
