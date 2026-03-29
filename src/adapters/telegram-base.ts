import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import TelegramBot from "node-telegram-bot-api";
import { basename, join } from "path";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { markdownToTelegramHtml } from "./telegram-format.js";
import { createTwoMessageContext } from "./context.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// TelegramBase — abstract base class for Telegram adapters
// ============================================================================

/** Escape text for Telegram HTML parse mode */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface TelegramBaseConfig {
	botToken: string;
	workingDir: string;
}

type QueuedWork = () => Promise<void>;

export abstract class TelegramBase implements PlatformAdapter {
	readonly name = "telegram";
	readonly maxMessageLength = 4096;
	readonly formatInstructions = `## Text Formatting
Use markdown: **bold**, *italic*, \`code\`, \`\`\`blocks\`\`\`, [links](url), ~~strikethrough~~.
When mentioning users, use @username format.`;

	protected bot: TelegramBot;
	protected handler!: MomHandler;
	protected workingDir: string;
	protected botToken: string;

	// Track users/channels we've seen
	protected users = new Map<string, UserInfo>();
	protected channels = new Map<string, ChannelInfo>();
	private queues = new Map<string, QueuedWork[]>();
	private processing = new Map<string, boolean>();

	constructor(config: TelegramBaseConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;
		// Always construct with polling: false — subclasses control lifecycle
		this.bot = new TelegramBot(config.botToken, { polling: false });
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	// ==========================================================================
	// Abstract — subclasses implement connection lifecycle
	// ==========================================================================

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;

	// ==========================================================================
	// Shared incoming message handler
	// ==========================================================================

	protected handleIncomingMessage(msg: TelegramBot.Message): void {
		const hasMedia = !!(msg.voice || msg.audio || msg.document || msg.photo || msg.video || msg.video_note);
		if ((!msg.text && !msg.caption && !hasMedia) || msg.from?.is_bot) return;

		const chatId = String(msg.chat.id);
		const userId = String(msg.from!.id);
		const userName = msg.from!.username || msg.from!.first_name || userId;
		const displayName = [msg.from!.first_name, msg.from!.last_name].filter(Boolean).join(" ") || userName;

		// Track user
		this.users.set(userId, { id: userId, userName, displayName });

		// Track channel/chat
		const chatName = msg.chat.title || (msg.chat.type === "private" ? `DM:${userName}` : chatId);
		this.channels.set(chatId, { id: chatId, name: chatName });

		// Extract text: prefer text, fall back to caption, then synthesize from media type
		const text = msg.text || msg.caption || this.describeMedia(msg);

		// Download media files async, then dispatch event
		this.processMessageWithMedia(msg, chatId, userId, userName, displayName, text).catch((err) => {
			log.logWarning("Failed to process Telegram message with media", err instanceof Error ? err.message : String(err));
		});
	}

	private describeMedia(msg: TelegramBot.Message): string {
		if (msg.voice) return "[Voice message]";
		if (msg.audio) return `[Audio: ${msg.audio.title || "audio"}]`;
		if (msg.video_note) return "[Video message]";
		if (msg.video) return "[Video]";
		if (msg.document) return `[File: ${msg.document.file_name || "document"}]`;
		if (msg.photo) return "[Photo]";
		return "[Media]";
	}

	private async processMessageWithMedia(
		msg: TelegramBot.Message,
		chatId: string,
		userId: string,
		userName: string,
		displayName: string,
		text: string,
	): Promise<void> {
		// Download any attached media
		const attachments: Attachment[] = [];
		const fileInfo = this.extractFileInfo(msg);

		if (fileInfo) {
			try {
				const localPath = await this.downloadTelegramFile(chatId, fileInfo.fileId, fileInfo.fileName, String(msg.date));
				attachments.push({ original: fileInfo.fileName, local: localPath });
				log.logInfo(`[telegram] Downloaded ${fileInfo.fileName} → ${localPath}`);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[telegram] Failed to download file`, errMsg);
			}
		}

		const momEvent: MomEvent = {
			type: msg.chat.type === "private" ? "dm" : "mention",
			channel: chatId,
			ts: String(msg.date),
			user: userId,
			text,
			attachments,
		};

		// Log user message
		const chatName = this.channels.get(chatId)?.name || chatId;
		this.logToFile({
			date: new Date(msg.date * 1000).toISOString(),
			ts: String(msg.date),
			channel: `telegram:${chatName}`,
			channelId: chatId,
			user: userId,
			userName,
			displayName,
			text,
			attachments,
			isBot: false,
		});

		// Resolve pending input first (e.g. /login waiting for pasted URL).
		// Must bypass the queue entirely — the queue may be blocked waiting on this.
		if (this.handler.resolvePendingInput(chatId, text)) {
			return;
		}

		// Check for stop
		if (text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(chatId)) {
				this.handler.handleStop(chatId, this);
			} else {
				this.postMessage(chatId, "_Nothing running_");
			}
			return;
		}

		// Steer into active run or start new one
		if (this.handler.isRunning(chatId)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.enqueueWork(chatId, () => this.handler.handleEvent(momEvent, this));
		}
	}

	private extractFileInfo(msg: TelegramBot.Message): { fileId: string; fileName: string } | null {
		if (msg.voice) {
			return { fileId: msg.voice.file_id, fileName: "voice.ogg" };
		}
		if (msg.audio) {
			// Types don't include file_name but Telegram API sends it
			return { fileId: msg.audio.file_id, fileName: (msg.audio as any).file_name || msg.audio.title || "audio.mp3" };
		}
		if (msg.video_note) {
			return { fileId: msg.video_note.file_id, fileName: "video_note.mp4" };
		}
		if (msg.video) {
			// Types don't include file_name but Telegram API sends it
			return { fileId: msg.video.file_id, fileName: (msg.video as any).file_name || "video.mp4" };
		}
		if (msg.document) {
			return { fileId: msg.document.file_id, fileName: msg.document.file_name || "document" };
		}
		if (msg.photo && msg.photo.length > 0) {
			// Use the largest photo (last in array)
			const largest = msg.photo[msg.photo.length - 1];
			return { fileId: largest.file_id, fileName: "photo.jpg" };
		}
		return null;
	}

	private async downloadTelegramFile(_chatId: string, fileId: string, fileName: string, timestamp: string): Promise<string> {
		const fileUrl = await this.bot.getFileLink(fileId);

		const response = await fetch(fileUrl);
		if (!response.ok) {
			throw new Error(`Telegram file download failed: HTTP ${response.status}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());

		// Save to shared attachments dir
		const ts = Math.floor(parseFloat(timestamp) * 1000) || Date.now();
		const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
		const localFileName = `${ts}_${sanitized}`;
		const relativePath = `attachments/${localFileName}`;
		const fullPath = join(this.workingDir, relativePath);

		const dir = join(this.workingDir, "attachments");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		writeFileSync(fullPath, buffer);

		return relativePath;
	}

	// ==========================================================================
	// PlatformAdapter implementation
	// ==========================================================================

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.bot.sendMessage(Number(channel), markdownToTelegramHtml(text), { parse_mode: "HTML" });
		return String(result.message_id);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		try {
			await this.bot.editMessageText(markdownToTelegramHtml(text), {
				chat_id: Number(channel),
				message_id: Number(ts),
				parse_mode: "HTML",
			});
		} catch (err) {
			// Telegram throws if message content hasn't changed
			const errMsg = err instanceof Error ? err.message : String(err);
			if (!errMsg.includes("message is not modified")) {
				throw err;
			}
		}
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		try {
			await this.bot.deleteMessage(Number(channel), Number(ts));
		} catch {
			// Ignore errors (message may be too old to delete)
		}
	}

	async postInThread(channel: string, _threadTs: string, text: string): Promise<string> {
		// Telegram doesn't have threads in the same way — just post as reply
		const result = await this.bot.sendMessage(Number(channel), markdownToTelegramHtml(text), {
			reply_to_message_id: Number(_threadTs),
			parse_mode: "HTML",
		});
		return String(result.message_id);
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.bot.sendDocument(Number(channel), fileContent, {}, { filename: fileName });
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		const ch = this.channels.get(channel);
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: ch ? `telegram:${ch.name}` : `telegram:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChannelInfo[] {
		return Array.from(this.channels.values());
	}

	enqueueEvent(event: MomEvent): boolean {
		// Telegram chat IDs are numeric (positive for users, negative for groups)
		if (!/^-?\d+$/.test(event.channel)) return false;

		const queue = this.queues.get(event.channel) || [];
		if (queue.length >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.enqueueWork(event.channel, () => this.handler.handleEvent(event, this, true));
		return true;
	}

	protected readVerboseSetting(): boolean {
		try {
			const settingsPath = join(this.workingDir, "settings.json");
			if (existsSync(settingsPath)) {
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
				return settings.verbose !== false; // default true
			}
		} catch { /* ignore */ }
		return true;
	}

	// ==========================================================================
	// Context creation
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

		const headerLine = eventFilename
			? `<i>Starting event: ${escapeHtml(eventFilename)}</i>`
			: "<i>Thinking</i>";

		return createTwoMessageContext(
			{
				post: (ch, text) => this.postMessage(ch, text),
				update: (ch, id, text) => this.updateMessage(ch, id, text),
				delete: (ch, id) => this.deleteMessage(ch, id),
				formatStatus: (text) => `<i>${escapeHtml(text)}</i>`,
				throttleMs: 300,
				maxLength: this.maxMessageLength,
			},
			{
				headerLine,
				event,
				user,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(event.channel)?.name,
				isEvent,
				verbose: this.readVerboseSetting(),
			},
			{
				logBotResponse: (ch, text, ts) => this.logBotResponse(ch, text, ts),
				sendTyping: async () => {
					try {
						await this.bot.sendChatAction(Number(event.channel), "typing");
					} catch {
						// Ignore typing errors
					}
				},
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title),
			},
		);
	}

	// ==========================================================================
	// Private - Queue
	// ==========================================================================

	private enqueueWork(channelId: string, work: QueuedWork): void {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = [];
			this.queues.set(channelId, queue);
		}
		const enqueuedAt = Date.now();
		queue.push(async () => {
			const waitMs = Date.now() - enqueuedAt;
			if (waitMs > 500) {
				log.logInfo(`[queue] ${channelId} work waited ${waitMs}ms in queue (depth was ${queue!.length})`);
			}
			return work();
		});
		if (this.processing.get(channelId)) {
			log.logInfo(`[queue] ${channelId} enqueued (queue depth=${queue.length}, processing=true)`);
		}
		this.processQueue(channelId);
	}

	private async processQueue(channelId: string): Promise<void> {
		if (this.processing.get(channelId)) return;
		this.processing.set(channelId, true);

		const queue = this.queues.get(channelId);
		while (queue && queue.length > 0) {
			const work = queue.shift()!;
			try {
				await work();
			} catch (err) {
				log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
			}
		}

		this.processing.set(channelId, false);
	}
}
