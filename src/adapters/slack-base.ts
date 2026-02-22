import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";
import { markdownToSlackMrkdwn } from "./slack-format.js";

// ============================================================================
// Slack-specific types (internal to adapter)
// ============================================================================

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

export class ChannelQueue {
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
// SlackBase — abstract base class for Slack adapters
// ============================================================================

export interface SlackBaseConfig {
	botToken: string;
	workingDir: string;
	store: ChannelStore;
}

export abstract class SlackBase implements PlatformAdapter {
	readonly name = "slack";
	readonly maxMessageLength = 40000;
	readonly formatInstructions = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

When mentioning users, use <@username> format (e.g., <@mario>).`;

	protected webClient: WebClient;
	protected handler!: MomHandler;
	protected workingDir: string;
	protected store: ChannelStore;
	protected botUserId: string | null = null;
	protected startupTs: string | null = null;

	protected users = new Map<string, SlackUser>();
	protected channels = new Map<string, SlackChannel>();
	protected queues = new Map<string, ChannelQueue>();

	constructor(config: SlackBaseConfig) {
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.webClient = new WebClient(config.botToken);
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
	// Shared startup sequence (call from subclass start())
	// ==========================================================================

	protected async initMetadata(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();
	}

	protected markStarted(): void {
		this.startupTs = (Date.now() / 1000).toFixed(6);
		log.logConnected();
	}

	// ==========================================================================
	// PlatformAdapter implementation
	// ==========================================================================

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
		const result = await this.webClient.chat.postMessage({ channel, text: markdownToSlackMrkdwn(text) });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text: markdownToSlackMrkdwn(text) });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text: markdownToSlackMrkdwn(text) });
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
		// Slack channel IDs start with C (channel), D (DM), or G (group)
		if (!/^[CDG]/.test(event.channel)) return false;

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
	// Context creation
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
	// Shared event handling helpers
	// ==========================================================================

	protected getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	protected logUserMessage(event: MomEvent): Attachment[] {
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
	// Backfill
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
	// Fetch Users/Channels
	// ==========================================================================

	protected async fetchUsers(): Promise<void> {
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

	protected async fetchChannels(): Promise<void> {
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
