import { appendFileSync, existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { MomSettingsManager } from "../context.js";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { markdownToDiscordMarkdown, stripDiscordMentions } from "./discord-format.js";
import { createTwoMessageContext } from "./context.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// Discord REST API constants
// ============================================================================

const DISCORD_API = "https://discord.com/api/v10";

// ============================================================================
// DiscordBase — abstract base class for Discord adapters
// ============================================================================

export interface DiscordBaseConfig {
	botToken: string;
	applicationId: string;
	workingDir: string;
}

type QueuedWork = () => Promise<void>;

export abstract class DiscordBase implements PlatformAdapter {
	readonly name = "discord";
	readonly maxMessageLength = 2000;
	readonly formatInstructions = `## Text Formatting
Use standard markdown: **bold**, *italic*, \`code\`, \`\`\`blocks\`\`\`, [links](url), ~~strikethrough~~.
When mentioning users, use <@userId> format.`;

	protected botToken: string;
	protected applicationId: string;
	protected handler!: MomHandler;
	protected workingDir: string;

	// Track users/channels we've seen
	protected users = new Map<string, UserInfo>();
	protected channels = new Map<string, ChannelInfo>();
	private queues = new Map<string, QueuedWork[]>();
	private processing = new Map<string, boolean>();

	constructor(config: DiscordBaseConfig) {
		this.botToken = config.botToken;
		this.applicationId = config.applicationId;
		this.workingDir = config.workingDir;
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
	// Discord REST API helpers
	// ==========================================================================

	protected async discordFetch(
		path: string,
		options: RequestInit = {},
	): Promise<Response> {
		const url = `${DISCORD_API}${path}`;
		const headers: Record<string, string> = {
			authorization: `Bot ${this.botToken}`,
			...(options.headers as Record<string, string> || {}),
		};

		// Add content-type for JSON bodies
		if (options.body && typeof options.body === "string") {
			headers["content-type"] = "application/json";
		}

		const resp = await fetch(url, { ...options, headers });

		// Handle rate limits
		if (resp.status === 429) {
			const retryAfter = parseFloat(resp.headers.get("retry-after") || "1");
			log.logWarning(`[discord] Rate limited, retrying after ${retryAfter}s`);
			await new Promise((r) => setTimeout(r, retryAfter * 1000));
			return this.discordFetch(path, options);
		}

		return resp;
	}

	// ==========================================================================
	// Interaction response helpers (used by webhook adapter)
	// ==========================================================================

	/**
	 * Edit the original deferred interaction response.
	 * Used as the "final response" in the two-message pattern.
	 */
	async editInteractionResponse(interactionToken: string, content: string): Promise<void> {
		const chunks = chunkText(content, this.maxMessageLength);
		// Edit original with first chunk
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/@original`,
			{
				method: "PATCH",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(chunks[0]) }),
			},
		);
		// Send remaining chunks as follow-ups
		for (let i = 1; i < chunks.length; i++) {
			await this.discordFetch(
				`/webhooks/${this.applicationId}/${interactionToken}`,
				{
					method: "POST",
					body: JSON.stringify({ content: markdownToDiscordMarkdown(chunks[i]) }),
				},
			);
		}
	}

	/**
	 * Send a follow-up message to an interaction.
	 * Returns the message ID.
	 */
	async sendFollowup(interactionToken: string, content: string): Promise<string> {
		const chunks = chunkText(content, this.maxMessageLength);
		let lastId = "";
		for (const chunk of chunks) {
			const resp = await this.discordFetch(
				`/webhooks/${this.applicationId}/${interactionToken}`,
				{
					method: "POST",
					body: JSON.stringify({ content: markdownToDiscordMarkdown(chunk) }),
				},
			);
			if (resp.ok) {
				const data = (await resp.json()) as { id: string };
				lastId = data.id;
			}
		}
		return lastId;
	}

	/**
	 * Edit a follow-up message.
	 */
	async editFollowup(interactionToken: string, messageId: string, content: string): Promise<void> {
		const truncated = content.length > this.maxMessageLength
			? content.substring(0, this.maxMessageLength - 3) + "..."
			: content;
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/${messageId}`,
			{
				method: "PATCH",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(truncated) }),
			},
		);
	}

	/**
	 * Delete a follow-up message.
	 */
	async deleteFollowup(interactionToken: string, messageId: string): Promise<void> {
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/${messageId}`,
			{ method: "DELETE" },
		);
	}

	// ==========================================================================
	// PlatformAdapter — standard message operations (channel-based)
	// These are used by ping/send_message tool for cross-channel messaging.
	// ==========================================================================

	async postMessage(channel: string, text: string): Promise<string> {
		const chunks = chunkText(text, this.maxMessageLength);
		let lastId = "";
		for (const chunk of chunks) {
			const resp = await this.discordFetch(`/channels/${channel}/messages`, {
				method: "POST",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(chunk) }),
			});
			if (resp.ok) {
				const data = (await resp.json()) as { id: string };
				lastId = data.id;
			}
		}
		return lastId;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		const truncated = text.length > this.maxMessageLength
			? text.substring(0, this.maxMessageLength - 3) + "..."
			: text;
		await this.discordFetch(`/channels/${channel}/messages/${ts}`, {
			method: "PATCH",
			body: JSON.stringify({ content: markdownToDiscordMarkdown(truncated) }),
		});
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		try {
			await this.discordFetch(`/channels/${channel}/messages/${ts}`, {
				method: "DELETE",
			});
		} catch {
			// Ignore errors (message may already be deleted)
		}
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		// Discord threads are channels — post with message_reference
		const resp = await this.discordFetch(`/channels/${channel}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: markdownToDiscordMarkdown(text.substring(0, this.maxMessageLength)),
				message_reference: { message_id: threadTs },
			}),
		});
		if (resp.ok) {
			const data = (await resp.json()) as { id: string };
			return data.id;
		}
		return "";
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		const boundary = `----FormBoundary${Date.now()}`;

		const parts: Buffer[] = [];
		// File part
		parts.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		));
		parts.push(fileContent);
		parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

		const body = Buffer.concat(parts);

		await this.discordFetch(`/channels/${channel}/messages`, {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			body,
		});
	}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		const ch = this.channels.get(channel);
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: ch ? `discord:#${ch.name}` : `discord:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Metadata
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

	enqueueEvent(event: MomEvent): boolean {
		// Discord snowflake IDs are 17-20 digit numbers
		if (!/^\d{17,20}$/.test(event.channel)) return false;

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

	/**
	 * Create a context for interaction-based messages.
	 * The interaction token is stored in the event metadata and used
	 * for the two-message pattern (deferred response → follow-up).
	 */
	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
		const headerLine = eventFilename
			? `*Starting event: ${eventFilename}*`
			: "*Thinking*";

		// Extract interaction token from event metadata (set by webhook adapter)
		const interactionToken = (event as any)._interactionToken as string | undefined;

		// If we have an interaction token, use interaction-based messaging.
		// Otherwise fall back to channel-based messaging (e.g., from events system).
		// Escape underscores in status text so Discord doesn't interpret them as italics
		const formatStatus = (text: string) => `*${text.replace(/_/g, "\\_")}*`;

		const ops = interactionToken
			? {
				post: async (ch: string, text: string) => {
					return await this.sendFollowup(interactionToken, text);
				},
				update: async (_ch: string, id: string, text: string) => {
					// id === "@original" means edit the deferred response
					if (id === "@original") {
						await this.editInteractionResponse(interactionToken, text);
					} else {
						await this.editFollowup(interactionToken, id, text);
					}
				},
				delete: async (_ch: string, id: string) => {
					if (id === "@original") return; // Don't delete the deferred response
					await this.deleteFollowup(interactionToken, id);
				},
				formatStatus,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			}
			: {
				post: (ch: string, text: string) => this.postMessage(ch, text),
				update: (ch: string, id: string, text: string) => this.updateMessage(ch, id, text),
				delete: (ch: string, id: string) => this.deleteMessage(ch, id),
				formatStatus,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			};

		return createTwoMessageContext(
			ops,
			{
				headerLine,
				event,
				user,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(event.channel)?.name,
				isEvent,
				verbose: new MomSettingsManager(this.workingDir).getVerbose(event.channel, "discord"),
			},
			{
				logBotResponse: (ch, text, ts) => this.logBotResponse(ch, text, ts),
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title),
			},
		);
	}

	// ==========================================================================
	// Queue
	// ==========================================================================

	protected enqueueWork(channelId: string, work: QueuedWork): void {
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

// ============================================================================
// Text chunking for Discord's 2000 char limit
// ============================================================================

function chunkText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Try to break at a newline
		let breakPoint = remaining.lastIndexOf("\n", maxLength);
		if (breakPoint < maxLength * 0.5) {
			// No good newline break — try space
			breakPoint = remaining.lastIndexOf(" ", maxLength);
		}
		if (breakPoint < maxLength * 0.3) {
			// No good break point — hard cut
			breakPoint = maxLength;
		}

		chunks.push(remaining.substring(0, breakPoint));
		remaining = remaining.substring(breakPoint).trimStart();
	}

	return chunks;
}
