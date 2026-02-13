import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// Slack-specific types (internal to this adapter)
// ============================================================================

interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

interface SlackChannel {
	id: string;
	name: string;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackAdapter
// ============================================================================

export interface SlackAdapterConfig {
	appToken: string;
	botToken: string;
	workingDir: string;
	store: ChannelStore;
}

export class SlackAdapter implements PlatformAdapter {
	readonly name = "slack";
	readonly maxMessageLength = 40000;
	readonly formatInstructions = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

When mentioning users, use <@username> format (e.g., <@mario>).`;

	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler!: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(config: SlackAdapterConfig) {
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	/**
	 * Set the handler that will receive events from this adapter.
	 * Must be called before start().
	 */
	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	// ==========================================================================
	// PlatformAdapter implementation
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackAdapter: handler not set. Call setHandler() before start().");

		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		this.startupTs = (Date.now() / 1000).toFixed(6);
		log.logConnected();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
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

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
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

	enqueueEvent(event: MomEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Slack-specific: Create MomContext from a Slack event
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		let messageTs: string | null = null;
		const threadMessageTs: string[] = [];
		let accumulatedText = "";
		let isWorking = true;
		const workingIndicator = " ...";
		let updatePromise = Promise.resolve();

		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

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
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await this.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await this.postMessage(event.channel, displayText);
					}

					if (shouldLog && messageTs) {
						this.logBotResponse(event.channel, text, messageTs);
					}
				});
				await updatePromise;
			},

			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					if (messageTs) {
						await this.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await this.postMessage(event.channel, displayText);
					}
				});
				await updatePromise;
			},

			respondInThread: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageTs) {
						const ts = await this.postInThread(event.channel, messageTs, text);
						threadMessageTs.push(ts);
					}
				});
				await updatePromise;
			},

			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageTs) {
					updatePromise = updatePromise.then(async () => {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							messageTs = await this.postMessage(event.channel, accumulatedText + workingIndicator);
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
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await this.updateMessage(event.channel, messageTs, displayText);
					}
				});
				await updatePromise;
			},

			deleteMessage: async () => {
				updatePromise = updatePromise.then(async () => {
					for (let i = threadMessageTs.length - 1; i >= 0; i--) {
						try {
							await this.deleteMessage(event.channel, threadMessageTs[i]);
						} catch {
							// Ignore errors deleting thread messages
						}
					}
					threadMessageTs.length = 0;
					if (messageTs) {
						await this.deleteMessage(event.channel, messageTs);
						messageTs = null;
					}
				});
				await updatePromise;
			},
		};
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const momEvent: MomEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${momEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			if (momEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this);
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			if (this.handler.isRunning(e.channel)) {
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const momEvent: MomEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${momEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			if (isDM) {
				if (momEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this);
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
				}
			}

			ack();
		});
	}

	private logUserMessage(event: MomEvent): Attachment[] {
		const user = this.users.get(event.user);
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs,
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevantMessages.reverse();

		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
