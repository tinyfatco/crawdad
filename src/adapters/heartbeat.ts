/**
 * HeartbeatAdapter — headless adapter for spontaneous agent wake-ups.
 *
 * Always created implicitly (not via --adapter flag). Owns its own scheduling
 * timer — reads spontaneity settings from settings.json, computes jittered
 * next-fire times, and self-triggers via handler.handleEvent().
 *
 * Exposes getNextFire() so the /schedule endpoint can include the heartbeat
 * in the wake manifest for the DO alarm chain (container wakes from sleep).
 *
 * No event file needed — settings.json is the single source of truth.
 */

import { appendFileSync } from "fs";
import { join } from "path";
import { MomSettingsManager, type MomSpontaneitySettings } from "../context.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

export const HEARTBEAT_CHANNEL_ID = "heartbeat";

export interface HeartbeatAdapterConfig {
	workingDir: string;
}

/**
 * If a timestamp falls inside the quiet hours window, push it to the end.
 */
function pushPastQuietHours(
	timestampMs: number,
	quietHours: { start: string; end: string },
	timezone: string,
): number {
	const [startH, startM] = quietHours.start.split(":").map(Number);
	const [endH, endM] = quietHours.end.split(":").map(Number);

	const d = new Date(timestampMs);
	const timeStr = d.toLocaleTimeString("en-US", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" });
	const [h, m] = timeStr.split(":").map(Number);

	const timeMinutes = h * 60 + m;
	const startMinutes = startH * 60 + startM;
	const endMinutes = endH * 60 + endM;

	let inQuiet: boolean;
	if (startMinutes <= endMinutes) {
		inQuiet = timeMinutes >= startMinutes && timeMinutes < endMinutes;
	} else {
		// Overnight: e.g. 23:00-07:00
		inQuiet = timeMinutes >= startMinutes || timeMinutes < endMinutes;
	}

	if (!inQuiet) return timestampMs;

	// Push to end of quiet hours
	const dateStr = d.toLocaleDateString("en-CA", { timeZone: timezone });
	const endTarget = new Date(`${dateStr}T${quietHours.end}:00`);
	const tzDate = new Date(endTarget.toLocaleString("en-US", { timeZone: timezone }));
	const offset = endTarget.getTime() - tzDate.getTime();
	let endMs = endTarget.getTime() + offset;

	if (endMs <= timestampMs) {
		endMs += 24 * 60 * 60 * 1000;
	}

	return endMs;
}

export class HeartbeatAdapter implements PlatformAdapter {
	readonly name = "heartbeat";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Heartbeat (Internal Reflection)
You are waking up for a spontaneous reflection. This is your internal channel — no one sees this directly unless they check the awareness stream.

Review your recent context and decide what to do:

1. **Incomplete work:** Did anything crash or fail to deliver? If so, pick it up and finish it. Use \`set_working_channel\` to target the right channel (email, Telegram, Slack) and complete the work.
2. **Proactive outreach:** Is there anything worth reaching out to your owner about? A follow-up, a reminder, something you noticed? Use \`set_working_channel\` to the appropriate channel and send it.
3. **Observations:** Note anything interesting in your context — patterns, pending items, things to watch. Even if you don't act, a brief observation is valuable.

If nothing needs attention, note a brief thought and go back to sleep. Avoid saying "nothing to do" — find something worth noticing, even if small.`;

	private workingDir: string;
	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;
	private timer: NodeJS.Timeout | null = null;
	private nextFireMs: number | null = null;
	private settings: MomSpontaneitySettings;

	constructor(config: HeartbeatAdapterConfig) {
		this.workingDir = config.workingDir;
		const settingsManager = new MomSettingsManager(config.workingDir);
		this.settings = settingsManager.getSpontaneitySettings();
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.settings.enabled) {
			log.logInfo("Heartbeat adapter disabled (spontaneity.enabled = false)");
			return;
		}

		log.logInfo(`Heartbeat adapter starting (interval=${this.settings.intervalMinutes}min, spontaneity=${this.settings.spontaneity})`);
		this.scheduleNext();
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.nextFireMs = null;
	}

	/**
	 * Get the next scheduled heartbeat fire time (ISO string).
	 * Used by /schedule endpoint for the DO wake manifest.
	 */
	getNextFire(): string | null {
		if (!this.nextFireMs) return null;
		return new Date(this.nextFireMs).toISOString();
	}

	private scheduleNext(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}

		const baseMs = this.settings.intervalMinutes * 60 * 1000;
		const jitter = (Math.random() * 2 - 1) * this.settings.spontaneity * baseMs;
		let nextMs = Date.now() + baseMs + jitter;

		// Enforce minimum 30s interval (safety floor for testing)
		if (nextMs - Date.now() < 30_000) {
			nextMs = Date.now() + 30_000;
		}

		const tz = this.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

		if (this.settings.quietHours) {
			nextMs = pushPastQuietHours(nextMs, this.settings.quietHours, tz);
		}

		this.nextFireMs = nextMs;
		const delay = nextMs - Date.now();
		const nextFire = new Date(nextMs).toISOString();

		log.logInfo(`Heartbeat scheduled in ${Math.round(delay / 1000)}s (${nextFire})`);

		this.timer = setTimeout(() => {
			this.timer = null;
			this.fireHeartbeat();
		}, delay);
	}

	private fireHeartbeat(): void {
		log.logInfo("Heartbeat firing");

		const event: MomEvent = {
			type: "mention",
			channel: HEARTBEAT_CHANNEL_ID,
			user: "heartbeat",
			text: "[heartbeat] Spontaneous reflection",
			ts: Date.now().toString(),
		};

		this.enqueueEvent(event);

		// Schedule next heartbeat after this one completes
		this.scheduleNext();
	}

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
