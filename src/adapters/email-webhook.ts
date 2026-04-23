import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { composeEmailReplyBody, type EmailReplyQuote } from "./email/reply-composer.js";
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
	replyQuote?: {
		body: string;
		from?: string;
		sentAt?: string;
	};
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

interface ActiveEmailReplyContext {
	channelId: string;
	canonicalChannel: string;
	toAddress: string;
	subject: string;
	messageId?: string;
	references?: string;
	replyQuote?: EmailReplyQuote;
}

interface LoggedEmailThreadEntry {
	ts: string;
	channelId?: string;
	user?: string;
	text?: string;
	isBot?: boolean;
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
	/** Active reply contexts used by send_message_to_channel to preserve email threading */
	private activeReplyContexts = new Map<string, ActiveEmailReplyContext>();

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
		req.on("end", async () => {
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

			const holdConnection = !!process.env.MOM_HOLD_WEBHOOK_CONNECTION;

			if (!holdConnection) {
				// Fire-and-forget (crawdad-cf mode)
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}

			// Process email
			try {
				await this.processEmail(payload);
			} catch (err) {
				log.logWarning("Email processing error", err instanceof Error ? err.message : String(err));
			}

			if (holdConnection) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
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
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `email:${payload.from}`,
			channelId,
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

	private saveAttachments(payload: EmailPayload, _channelId: string): Map<string, string> {
		const saved = new Map<string, string>();
		if (!payload.attachments || payload.attachments.length === 0) return saved;

		const dir = join(this.workingDir, "attachments");
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

	private normalizeEmailAddress(value: string): string {
		const trimmed = value.trim();
		const angleMatch = trimmed.match(/<([^>]+)>/);
		return (angleMatch ? angleMatch[1] : trimmed).toLowerCase();
	}

	private buildReplySubject(subject: string): string {
		return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
	}

	private extractSubjectFromLoggedText(text: string): string | undefined {
		const match = text.match(/^Subject:\s*(.+)$/m);
		return match?.[1]?.trim();
	}

	private stripEmailLogDecorations(text: string): string {
		let cleaned = text.replace(/^Subject:\s*.+?(?:\n\n|$)/, "");
		const attachmentsIndex = cleaned.indexOf("\n\nAttachments saved to disk:\n");
		if (attachmentsIndex !== -1) {
			cleaned = cleaned.slice(0, attachmentsIndex);
		}
		return cleaned.trim();
	}

	private formatParticipantLabel(value: string, fallback: string): string {
		const trimmed = value.trim();
		const angleMatch = trimmed.match(/^(.*?)(?:\s*<([^>]+)>)\s*$/);
		if (!angleMatch) return trimmed || fallback;
		const displayName = angleMatch[1]?.trim().replace(/^"|"$/g, "");
		return displayName || angleMatch[2]?.trim() || fallback;
	}

	private buildConversationReplyBody(channelId: string, payload: EmailPayload, currentTs: string): string | undefined {
		const logPath = join(this.workingDir, "log.jsonl");
		if (!existsSync(logPath)) return undefined;

		let raw: string;
		try {
			raw = readFileSync(logPath, "utf-8");
		} catch {
			return undefined;
		}

		const currentTsNum = Number(currentTs);
		const channelEntries = raw
			.split("\n")
			.map((line) => {
				if (!line.trim()) return undefined;
				try {
					return JSON.parse(line) as LoggedEmailThreadEntry;
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is LoggedEmailThreadEntry => {
				if (!entry?.channelId || entry.channelId !== channelId || !entry.text) return false;
				const tsNum = Number(entry.ts);
				return Number.isNaN(tsNum) ? true : tsNum <= currentTsNum;
			});

		if (channelEntries.length === 0) return undefined;

		const currentEntry = channelEntries[channelEntries.length - 1];
		const currentBody = (payload.replyQuote?.body || this.stripEmailLogDecorations(currentEntry.text || payload.body) || payload.body).trim();
		if (!currentBody) return undefined;

		const currentSubject = payload.subject.trim();
		const priorEntries: LoggedEmailThreadEntry[] = [];
		let pendingBots: LoggedEmailThreadEntry[] = [];

		for (let i = channelEntries.length - 2; i >= 0; i--) {
			const entry = channelEntries[i];
			if (!entry.text) continue;

			if (entry.isBot) {
				pendingBots.unshift(entry);
				continue;
			}

			const entrySubject = this.extractSubjectFromLoggedText(entry.text);
			if (currentSubject && entrySubject && entrySubject !== currentSubject) {
				break;
			}

			priorEntries.unshift(...pendingBots);
			pendingBots = [];
			priorEntries.unshift(entry);
		}

		if (priorEntries.length === 0) return currentBody;

		const senderLabel = this.formatParticipantLabel(payload.from, "User");
		const agentLabel = this.normalizeEmailAddress(payload.to).split("@")[0] || "Agent";
		const priorBlocks = priorEntries
			.map((entry) => {
				const body = this.stripEmailLogDecorations(entry.text || "");
				if (!body) return "";
				const label = entry.isBot ? agentLabel : senderLabel;
				return `${label}:\n${body}`;
			})
			.filter(Boolean);

		if (priorBlocks.length === 0) return currentBody;

		return `${currentBody}\n\nEarlier in this conversation:\n\n${priorBlocks.join("\n\n")}`;
	}

	private buildReplyQuote(channelId: string, payload: EmailPayload, currentTs: string, fallbackSentAt?: string): EmailReplyQuote | undefined {
		const body = this.buildConversationReplyBody(channelId, payload, currentTs) || payload.replyQuote?.body || payload.body;
		if (!body?.trim()) return undefined;
		return {
			body,
			from: payload.replyQuote?.from || payload.from,
			sentAt: payload.replyQuote?.sentAt || fallbackSentAt,
		};
	}

	private registerActiveReplyContext(channelId: string, payload: EmailPayload, currentTs: string): ActiveEmailReplyContext {
		const fallbackSentAt = new Date(Number(currentTs)).toISOString();
		const toAddress = this.normalizeEmailAddress(payload.from);
		const canonicalChannel = `email-${toAddress}`;
		const context: ActiveEmailReplyContext = {
			channelId,
			canonicalChannel,
			toAddress,
			subject: payload.subject || "(no subject)",
			messageId: payload.messageId,
			references: payload.references,
			replyQuote: this.buildReplyQuote(channelId, payload, currentTs, fallbackSentAt),
		};
		this.activeReplyContexts.set(channelId, context);
		this.activeReplyContexts.set(canonicalChannel, context);
		return context;
	}

	private clearActiveReplyContext(context?: ActiveEmailReplyContext): void {
		if (!context) return;
		this.activeReplyContexts.delete(context.channelId);
		this.activeReplyContexts.delete(context.canonicalChannel);
	}

	private resolveActiveReplyContext(channel: string): ActiveEmailReplyContext | undefined {
		const direct = this.activeReplyContexts.get(channel);
		if (direct) return direct;
		const emailMatch = channel.match(/^email-(.+)$/);
		if (!emailMatch) return undefined;
		return this.activeReplyContexts.get(`email-${this.normalizeEmailAddress(emailMatch[1])}`);
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops for email)
	// ==========================================================================

	async postMessage(channel: string, text: string, attachments?: Array<{ filePath: string; filename: string }>, subject?: string): Promise<string> {
		// Cross-channel send: channel format is "email-{address}"
		const emailMatch = channel.match(/^email-(.+)$/);
		if (!emailMatch) {
			throw new Error(`postMessage called with non-email channel: ${channel}`);
		}

		const replyContext = this.resolveActiveReplyContext(channel);
		const toAddress = replyContext?.toAddress || this.normalizeEmailAddress(emailMatch[1]);
		const body = replyContext ? composeEmailReplyBody(text, replyContext.replyQuote) : text;
		const resolvedSubject = replyContext
			? (subject || this.buildReplySubject(replyContext.subject))
			: (subject || "Message from your agent");
		log.logInfo(`[email] Sending ${replyContext ? "threaded " : ""}outbound to ${toAddress}${attachments?.length ? ` with ${attachments.length} attachment(s)` : ""}`);

		const emailMetadata: Record<string, unknown> = {
			to: toAddress,
			subject: resolvedSubject,
			body,
		};

		if (replyContext?.messageId) {
			emailMetadata.in_reply_to = replyContext.messageId;
			emailMetadata.references = replyContext.references
				? `${replyContext.references} ${replyContext.messageId}`
				: replyContext.messageId;
		}

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

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `email:${channel.replace("email-", "")}`,
			channelId: channel,
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
		const activeReplyContext = payload ? this.registerActiveReplyContext(event.channel, payload, event.ts) : undefined;
		const emailMeta = {
			from: event.user,
			selfEmail: payload?.to?.toLowerCase(), // agent's own address — exclude from reply-all
			subject: payload?.subject || "(no subject)",
			messageId: payload?.messageId,
			inReplyTo: payload?.inReplyTo,
			references: payload?.references,
			allRecipients: payload?.allRecipients || [],
			replyQuote: activeReplyContext?.replyQuote,
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

			sendFinalResponse: async (text: string) => {
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
					try {
						await this.sendEmailReply(emailMeta, finalText, toolLog, pendingAttachments);
					} finally {
						this.clearActiveReplyContext(activeReplyContext);
					}
				}
			},

			deleteMessage: async () => {
				// No-op for email
			},

			restartWorking: async () => {
				// No-op for email
			},
		};
	}

	// ==========================================================================
	// Email reply — the one outbound message
	// ==========================================================================

	private async sendEmailReply(
		meta: { from: string; selfEmail?: string; subject: string; messageId?: string; inReplyTo?: string; references?: string; allRecipients?: string[]; replyQuote?: EmailReplyQuote },
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
		const replyBody = composeEmailReplyBody(finalText, meta.replyQuote);
		const logModeEnv = (process.env.MOM_EMAIL_LOG_MODE || "none").toLowerCase();
		const logMode = logModeEnv === "inline" || logModeEnv === "attachment" ? logModeEnv : "none";

		const replySubject = meta.subject.startsWith("Re:") ? meta.subject : `Re: ${meta.subject}`;

		// Reply-all: combine sender + all other recipients, deduped
		// Filter out the agent's own address to avoid CC'ing itself
		const allTo = new Set<string>();
		allTo.add(meta.from.toLowerCase());
		if (meta.allRecipients) {
			for (const addr of meta.allRecipients) {
				const lower = addr.toLowerCase();
				if (meta.selfEmail && lower === meta.selfEmail) continue;
				allTo.add(lower);
			}
		}
		const toList = Array.from(allTo).join(", ");

		const emailMetadata: Record<string, unknown> = {
			to: toList,
			subject: replySubject,
			body: replyBody,
		};

		// Human-facing email defaults to no inline work log.
		// Operators can opt back in with MOM_EMAIL_LOG_MODE=inline|attachment.
		if (conciseLog && logMode !== "none") {
			emailMetadata.log = logMode;
			emailMetadata.log_content = conciseLog;
		}

		// Add threading headers (reply to the original message)
		if (meta.messageId) {
			emailMetadata.in_reply_to = meta.messageId;
			emailMetadata.references = meta.references
				? `${meta.references} ${meta.messageId}`
				: meta.messageId;
		}

		log.logInfo(`[email] Sending reply to ${toList}: ${replySubject}`);

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
