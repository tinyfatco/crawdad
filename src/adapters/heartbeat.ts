/**
 * HeartbeatAdapter — headless adapter for spontaneous agent wake-ups.
 *
 * Always created implicitly (not via --adapter flag). Accepts events on the
 * "heartbeat" channel, runs the agent with a no-op context (output goes to
 * awareness/context.jsonl via the runner, not to any external platform).
 *
 * The agent can configure its own heartbeat behavior via HEARTBEAT.md in the
 * workspace root. Three states:
 *   - File with content → injected as the heartbeat checklist
 *   - File exists but empty → heartbeat run is skipped entirely
 *   - File doesn't exist → run with default generic prompt
 *
 * Scheduling is handled by the events system (periodic event file in events/).
 * This adapter just accepts and runs the events headlessly.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

export const HEARTBEAT_CHANNEL_ID = "heartbeat";

/**
 * Check if HEARTBEAT.md content is effectively empty — only whitespace,
 * markdown headers, or empty list items. Means the agent/owner has
 * deliberately cleared the checklist → skip the heartbeat run.
 */
function isEffectivelyEmpty(content: string): boolean {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Markdown headers (# Title, ## etc)
		if (/^#+(\s|$)/.test(trimmed)) continue;
		// Empty list items (- , * , - [ ], etc)
		if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue;
		// Found actual content
		return false;
	}
	return true;
}

export class HeartbeatAdapter implements PlatformAdapter {
	readonly name = "heartbeat";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Heartbeat (Internal Reflection)
You are waking up for a spontaneous reflection. This is your internal channel — no one sees this directly unless they check the awareness stream.

Review your recent context and decide what to do:

1. **Incomplete work:** Did anything crash or fail to deliver? If so, pick it up and finish it. Use \`send_message_to_channel\` to deliver on the right channel (email, Telegram, Slack).
2. **Proactive outreach:** Is there anything worth reaching out to your owner about? A follow-up, a reminder, something you noticed? Use \`send_message_to_channel\` to send it on the appropriate channel.
3. **Observations:** Note anything interesting in your context — patterns, pending items, things to watch. Even if you don't act, a brief observation is valuable.

If nothing needs attention, note a brief thought and go back to sleep. Avoid saying "nothing to do" — find something worth noticing, even if small.`;

	private workingDir: string;
	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;

	constructor(config: { workingDir: string }) {
		this.workingDir = config.workingDir;
	}

	/**
	 * Read HEARTBEAT.md from workspace root.
	 * Returns { exists, content } — content is empty string if file missing.
	 */
	private readHeartbeatFile(): { exists: boolean; content: string } {
		const filePath = join(this.workingDir, "HEARTBEAT.md");
		try {
			if (existsSync(filePath)) {
				return { exists: true, content: readFileSync(filePath, "utf-8") };
			}
		} catch {}
		return { exists: false, content: "" };
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Heartbeat adapter ready");
	}

	async stop(): Promise<void> {}

	// -- Message operations (all no-ops — heartbeat is headless) --

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	// -- Logging --

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `heartbeat:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// -- Metadata --

	getUser(_userId: string): UserInfo | undefined {
		return undefined;
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		if (channelId === HEARTBEAT_CHANNEL_ID) {
			return { id: HEARTBEAT_CHANNEL_ID, name: "heartbeat" };
		}
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [];
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: HEARTBEAT_CHANNEL_ID, name: "heartbeat" }];
	}

	// -- Event queue --

	enqueueEvent(event: MomEvent): boolean {
		if (event.channel !== HEARTBEAT_CHANNEL_ID) return false;

		if (this.queue.length >= 3) {
			log.logWarning(`Heartbeat queue full, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}

		log.logInfo(`Heartbeat event enqueued: ${event.text.substring(0, 80)}`);
		this.queue.push(event);
		this.processQueue();
		return true;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				try {
					const heartbeat = this.readHeartbeatFile();

					if (heartbeat.exists && isEffectivelyEmpty(heartbeat.content)) {
						log.logInfo("Heartbeat skipped (HEARTBEAT.md empty)");
						continue;
					}

					if (heartbeat.exists && heartbeat.content.trim()) {
						event.text += `\n\n## Heartbeat Checklist\n${heartbeat.content.trim()}`;
						log.logInfo("Heartbeat: injected HEARTBEAT.md content");
					}

					await this.handler.handleEvent(event, this, true);
				} catch (err) {
					log.logWarning("Heartbeat run failed", err instanceof Error ? err.message : String(err));
				}
			}
		} finally {
			this.processing = false;
		}
	}

	// -- Context creation (headless — no platform output) --

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "heartbeat",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: "heartbeat",
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
		};
	}
}
