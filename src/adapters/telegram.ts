import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import TelegramBot from "node-telegram-bot-api";
import { basename, join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// TelegramAdapter
// ============================================================================

/** Escape text for Telegram HTML parse mode */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface TelegramAdapterConfig {
	botToken: string;
	workingDir: string;
}

export class TelegramAdapter implements PlatformAdapter {
	readonly name = "telegram";
	readonly maxMessageLength = 4096;
	readonly formatInstructions = `## Text Formatting (Telegram HTML)
Bold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Block: <pre>code</pre>, Links: <a href="url">text</a>
Strikethrough: <s>text</s>, Underline: <u>text</u>
Do NOT use markdown formatting (* _ \` etc.) — use HTML tags only.

When mentioning users, use @username format.`;

	private bot: TelegramBot;
	private handler!: MomHandler;
	private workingDir: string;
	private botToken: string;

	// Track users/channels we've seen
	private users = new Map<string, UserInfo>();
	private channels = new Map<string, ChannelInfo>();
	private queues = new Map<string, QueuedWork[]>();
	private processing = new Map<string, boolean>();

	constructor(config: TelegramAdapterConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;
		this.bot = new TelegramBot(config.botToken, { polling: true });
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	// ==========================================================================
	// PlatformAdapter implementation
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramAdapter: handler not set. Call setHandler() before start().");

		const me = await this.bot.getMe();
		log.logInfo(`Telegram bot started: @${me.username} (${me.id})`);

		this.bot.on("message", (msg) => {
			if (!msg.text || msg.from?.is_bot) return;

			const chatId = String(msg.chat.id);
			const userId = String(msg.from!.id);
			const userName = msg.from!.username || msg.from!.first_name || userId;
			const displayName = [msg.from!.first_name, msg.from!.last_name].filter(Boolean).join(" ") || userName;

			// Track user
			this.users.set(userId, { id: userId, userName, displayName });

			// Track channel/chat
			const chatName = msg.chat.title || (msg.chat.type === "private" ? `DM:${userName}` : chatId);
			this.channels.set(chatId, { id: chatId, name: chatName });

			const momEvent: MomEvent = {
				type: msg.chat.type === "private" ? "dm" : "mention",
				channel: chatId,
				ts: String(msg.date),
				user: userId,
				text: msg.text,
			};

			// Log user message
			this.logToFile(chatId, {
				date: new Date(msg.date * 1000).toISOString(),
				ts: String(msg.date),
				user: userId,
				userName,
				displayName,
				text: msg.text,
				attachments: [],
				isBot: false,
			});

			// Check for stop
			if (msg.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(chatId)) {
					this.handler.handleStop(chatId, this);
				} else {
					this.postMessage(chatId, "_Nothing running_");
				}
				return;
			}

			// Check if busy
			if (this.handler.isRunning(chatId)) {
				this.postMessage(chatId, "_Already working. Say `stop` to cancel._");
			} else {
				this.enqueueWork(chatId, () => this.handler.handleEvent(momEvent, this));
			}
		});

		log.logConnected();
	}

	async stop(): Promise<void> {
		this.bot.stopPolling();
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.bot.sendMessage(Number(channel), text, { parse_mode: "HTML" });
		return String(result.message_id);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		try {
			await this.bot.editMessageText(text, {
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
		const result = await this.bot.sendMessage(Number(channel), text, {
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
		const queue = this.queues.get(event.channel) || [];
		if (queue.length >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.enqueueWork(event.channel, () => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Context creation
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		let messageId: string | null = null;
		let finalText = "";
		let isWorking = true;
		let updatePromise = Promise.resolve();

		// Rolling tool call display: show last 3, count completed
		const recentTools: string[] = []; // last 3 tool labels
		let completedToolCount = 0;

		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

		// Build the working status display
		const buildStatusDisplay = (): string => {
			const lines: string[] = [];

			// Header: completed tool count
			if (completedToolCount > 0) {
				lines.push(`<i>${completedToolCount} tool call${completedToolCount > 1 ? "s" : ""} completed</i>`);
			}

			// Show recent tools (last 3)
			for (const tool of recentTools) {
				lines.push(tool);
			}

			if (lines.length === 0) {
				return eventFilename ? `<i>Starting event: ${escapeHtml(eventFilename)}</i>` : "<i>Thinking</i>";
			}

			return lines.join("\n");
		};

		// Update the single message
		const updateDisplay = async () => {
			const display = isWorking ? buildStatusDisplay() + " ..." : finalText || buildStatusDisplay();
			if (messageId) {
				await this.updateMessage(event.channel, messageId, display);
			} else if (display) {
				messageId = await this.postMessage(event.channel, display);
			}
		};

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: user?.userName,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments || []).map((a) => ({ local: a.local })),
			},
			channelName: this.channels.get(event.channel)?.name,
			channels: this.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			users: this.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

			respond: async (text: string, shouldLog = true) => {
				updatePromise = updatePromise.then(async () => {
					// Tool labels (shouldLog=false, starts with _→) — track in rolling window
					if (!shouldLog && text.startsWith("_→")) {
						// Extract label: "_→ Reading file_" → "→ Reading file"
						const label = text.replace(/^_/, "").replace(/_$/, "");
						// Push old tools out, keep last 3
						if (recentTools.length >= 3) {
							recentTools.shift();
							completedToolCount++;
						}
						recentTools.push(`<i>${escapeHtml(label)}</i>`);
						await updateDisplay();
						return;
					}

					// Status messages (shouldLog=false) — transient
					if (!shouldLog) {
						await updateDisplay();
						return;
					}

					// Real content — accumulate
					finalText = finalText ? `${finalText}\n${text}` : text;
					await updateDisplay();
					if (messageId) {
						this.logBotResponse(event.channel, text, messageId);
					}
				});
				await updatePromise;
			},

			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					finalText = text;
					await updateDisplay();
				});
				await updatePromise;
			},

			// Telegram: swallow thread messages (tool details, duplicates, usage)
			respondInThread: async (_text: string) => {
				// No-op — tool details logged to log.jsonl, not posted to chat
			},

			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageId) {
					updatePromise = updatePromise.then(async () => {
						if (!messageId) {
							try {
								await this.bot.sendChatAction(Number(event.channel), "typing");
							} catch {
								// Ignore typing errors
							}
							messageId = await this.postMessage(event.channel, buildStatusDisplay() + " ...");
						}
					});
					await updatePromise;
				}
			},

			uploadFile: async (filePath: string, title?: string) => {
				await this.uploadFile(event.channel, filePath, title);
			},

			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					// When done working, count any remaining visible tools as completed
					if (!working) {
						completedToolCount += recentTools.length;
						recentTools.length = 0;
					}
					await updateDisplay();
				});
				await updatePromise;
			},

			deleteMessage: async () => {
				updatePromise = updatePromise.then(async () => {
					if (messageId) {
						await this.deleteMessage(event.channel, messageId);
						messageId = null;
					}
				});
				await updatePromise;
			},
		};
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
		queue.push(work);
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

type QueuedWork = () => Promise<void>;
