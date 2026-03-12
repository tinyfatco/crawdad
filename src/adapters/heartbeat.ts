import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import { createSendMessageTool } from "../tools/send-message.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// HeartbeatAdapter — internal adapter for autonomous agent thinking sessions
//
// The heartbeat adapter claims events with channelId "_heartbeat".
// It provides a silent-by-default context (no chat messages posted) and
// gives the agent a send_message tool to reach any channel via other adapters.
// ============================================================================

const HEARTBEAT_CHANNEL = "_heartbeat";

export class HeartbeatAdapter implements PlatformAdapter {
	readonly name = "heartbeat";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Heartbeat Mode (Autonomous Thinking Session)
You are in a **heartbeat** — an autonomous thinking session. No one messaged you.
You have woken up on your own schedule to think, act, and decide.

### What you can do:
- **Think**: Review your task list, memory, recent conversations
- **Send messages**: Use the \`send_message\` tool to reach people on any channel
- **Stay silent**: If nothing needs doing, respond with just \`[SILENT]\`
- **Schedule your next wake**: Write an event file to \`/data/events/\` to control when you next wake up

### Guidelines:
- Be spontaneous but not spammy. Most heartbeats should be silent.
- When you do reach out, be charming, concise, and purposeful.
- Check your task list and memory before deciding what to do.
- You can send to multiple channels in one heartbeat if warranted.
- Prefer organic timing — don't always send at exact intervals.`;

	private workingDir: string;
	private handler!: MomHandler;
	private otherAdapters: PlatformAdapter[] = [];

	constructor(config: { workingDir: string }) {
		this.workingDir = config.workingDir;
	}

	/** Set references to all other adapters for cross-channel routing */
	setOtherAdapters(adapters: PlatformAdapter[]): void {
		this.otherAdapters = adapters;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		// No-op — heartbeat is purely internal, driven by EventsWatcher
		log.logInfo("Heartbeat adapter ready");
	}

	async stop(): Promise<void> {
		// No-op
	}

	// No dispatch() — heartbeat has no inbound HTTP endpoint

	// ==========================================================================
	// Cross-channel send_message tool (delegates to shared module)
	// ==========================================================================

	/**
	 * Create the send_message tool for heartbeat runs.
	 * Delegates to the shared createSendMessageTool() in tools/send-message.ts.
	 */
	getSendMessageTool() {
		return createSendMessageTool(this.otherAdapters);
	}

	// ==========================================================================
	// Cross-channel activity summary
	// ==========================================================================

	/**
	 * Scan log.jsonl files across all channel directories and compile
	 * a summary of recent activity. Gives the heartbeat situational
	 * awareness of what's been happening across all channels.
	 */
	getRecentActivitySummary(hoursBack: number = 4): string {
		const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
		const channelActivity: Array<{ channel: string; adapter: string; messages: Array<{ user: string; text: string; date: string; isBot: boolean }> }> = [];

		// Scan all channel directories in workingDir
		let dirs: string[];
		try {
			dirs = readdirSync(this.workingDir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && d.name !== "events" && d.name !== "skills" && d.name !== HEARTBEAT_CHANNEL)
				.map((d) => d.name);
		} catch {
			return "(no recent activity)";
		}

		for (const channelId of dirs) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (!existsSync(logPath)) continue;

			try {
				const content = readFileSync(logPath, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);

				// Read from the end — recent messages are at the bottom
				const recent: Array<{ user: string; text: string; date: string; isBot: boolean }> = [];
				for (let i = lines.length - 1; i >= 0 && recent.length < 10; i--) {
					try {
						const entry = JSON.parse(lines[i]);
						const entryDate = new Date(entry.date);
						if (entryDate.getTime() < cutoff) break;

						recent.unshift({
							user: entry.isBot ? "you" : (entry.userName || entry.user || "unknown"),
							text: (entry.text || "").substring(0, 150),
							date: entry.date,
							isBot: entry.isBot,
						});
					} catch {
						// Skip malformed lines
					}
				}

				if (recent.length > 0) {
					// Determine adapter type from channel ID pattern
					let adapter = "unknown";
					if (/^-?\d+$/.test(channelId)) adapter = "telegram";
					else if (/^[CDG]/.test(channelId)) adapter = "slack";
					else if (channelId.startsWith("email-")) adapter = "email";
					else if (channelId.startsWith("web-")) adapter = "web";

					// Look up channel name
					const channelInfo = this.getChannel(channelId);
					const displayName = channelInfo ? `${channelInfo.name} (${adapter})` : `${channelId} (${adapter})`;

					channelActivity.push({ channel: displayName, adapter, messages: recent });
				}
			} catch {
				// Skip unreadable logs
			}
		}

		if (channelActivity.length === 0) {
			return "(no recent activity across channels)";
		}

		// Build the summary
		const parts: string[] = [];
		for (const { channel, messages } of channelActivity) {
			const msgSummary = messages.map((m) => {
				const time = new Date(m.date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
				return `  ${time} ${m.user}: ${m.text}`;
			}).join("\n");
			parts.push(`### ${channel}\n${msgSummary}`);
		}

		return parts.join("\n\n");
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops)
	// ==========================================================================

	async postMessage(_channel: string, _text: string): Promise<string> {
		// No-op — heartbeat doesn't post to a chat
		return String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
		// No-op
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// No-op
	}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {
		// No-op
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
	// Metadata — aggregate from all other adapters
	// ==========================================================================

	getUser(userId: string): UserInfo | undefined {
		for (const adapter of this.otherAdapters) {
			const user = adapter.getUser(userId);
			if (user) return user;
		}
		return undefined;
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		for (const adapter of this.otherAdapters) {
			const channel = adapter.getChannel(channelId);
			if (channel) return channel;
		}
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		const seen = new Set<string>();
		const users: UserInfo[] = [];
		for (const adapter of this.otherAdapters) {
			for (const user of adapter.getAllUsers()) {
				if (!seen.has(user.id)) {
					seen.add(user.id);
					users.push(user);
				}
			}
		}
		return users;
	}

	getAllChannels(): ChannelInfo[] {
		const seen = new Set<string>();
		const channels: ChannelInfo[] = [];
		for (const adapter of this.otherAdapters) {
			for (const channel of adapter.getAllChannels()) {
				if (!seen.has(channel.id)) {
					seen.add(channel.id);
					channels.push(channel);
				}
			}
		}
		return channels;
	}

	// ==========================================================================
	// Event queue — claim _heartbeat events
	// ==========================================================================

	enqueueEvent(event: MomEvent): boolean {
		if (event.channel !== HEARTBEAT_CHANNEL) return false;

		log.logInfo(`[heartbeat] Enqueueing heartbeat event: ${event.text.substring(0, 80)}`);
		this.handler.handleEvent(event, this, true).catch((err) => {
			log.logWarning("[heartbeat] Event handler error", err instanceof Error ? err.message : String(err));
		});
		return true;
	}

	// ==========================================================================
	// Context creation — silent by default
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		// Compile cross-channel activity summary and prepend to event text
		const activitySummary = this.getRecentActivitySummary();
		const enrichedText = `${event.text}\n\n## Recent Activity Across Channels\n${activitySummary}`;

		return {
			message: {
				text: enrichedText,
				rawText: event.text,
				user: "HEARTBEAT",
				userName: "heartbeat",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: "heartbeat",
			channels: this.getAllChannels(),
			users: this.getAllUsers(),

			// Silent context — all output goes to log only
			respond: async (text: string, shouldLog = true) => {
				if (shouldLog && text.trim()) {
					log.logInfo(`[heartbeat] respond: ${text.substring(0, 200)}`);
				}
			},

			sendFinalResponse: async (text: string) => {
				if (text.trim() && text.trim() !== "[SILENT]") {
					log.logInfo(`[heartbeat] final: ${text.substring(0, 200)}`);
				}
			},

			respondInThread: async (_text: string) => {
				// No-op — tool details go to log.jsonl
			},

			setTyping: async () => {
				// No-op
			},

			uploadFile: async () => {
				// No-op
			},

			setWorking: async (_working: boolean) => {
				// No-op
			},

			deleteMessage: async () => {
				// No-op
			},

			restartWorking: async () => {
				// No-op for heartbeat
			},
		};
	}
}
