/**
 * TickAdapter — high-frequency ambient presence loop.
 *
 * Parallel to HeartbeatAdapter, but fundamentally different in character:
 *   - Cadence: 1-10 min (vs heartbeat's hourly-ish)
 *   - Gating: only fires while presence state === "here"
 *   - Prompt: ambient "you're here" (vs heartbeat's "review and act")
 *   - Lifecycle: internal setInterval (vs heartbeat's external event files)
 *
 * The agent calls tune_in / tune_out to start/stop this adapter. While tuned
 * in, every tick fires the TICK.md prompt as a synthetic event, runs the
 * agent headlessly, and records the run outcome for auto-tune-out tracking.
 *
 * If a tick fires while the previous tick's run is still in-flight, the new
 * tick is SKIPPED (not queued). Ticks are ambient — a missed one is fine,
 * a backlog is bad.
 *
 * See memory-bank/03-design/presence-and-ticks.md for the full design.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import {
	getTickDisposition,
	getTickIntervalMs,
	isTunedIn,
	recordTickYield,
} from "../presence.js";
import { wasYielded } from "../tools/yield-no-action.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

export const TICK_CHANNEL_ID = "tick";

const DEFAULT_TICK_PROMPT = `A small amount of time has passed. You're tuned in. You're around.

This is a heartbeat. Look at your awareness and act. If you have active work, do it. If something is worth saying, use send_message_to_channel. If there's truly nothing, yield_no_action with a brief note.

You're here. Time is passing. Act on it.`;

export class TickAdapter implements PlatformAdapter {
	readonly name = "tick";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Tick (Ambient Presence)
You are tuned in. You received a tick — an ambient heartbeat. If you have active work, keep working. If something is worth saying, use \`send_message_to_channel\`. If there's quiet work to do, do it.

In narrating mode: you MUST message every tick with a short update. In quiet mode: only message if something genuinely surfaced.

If there is truly nothing to do and nothing to say, yield_no_action with a brief note.`;

	private workingDir: string;
	private awarenessDir: string;
	private handler!: MomHandler;
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(config: { workingDir: string; awarenessDir: string }) {
		this.workingDir = config.workingDir;
		this.awarenessDir = config.awarenessDir;
	}

	/**
	 * Read TICK.md from workspace root. Falls back to a baked-in default
	 * if the file is missing.
	 */
	private readTickPrompt(): string {
		const filePath = join(this.workingDir, "TICK.md");
		try {
			if (existsSync(filePath)) {
				const content = readFileSync(filePath, "utf-8").trim();
				if (content) return content;
			}
		} catch {}
		return DEFAULT_TICK_PROMPT;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Tick adapter ready");
		// Resume ticking on boot if presence file says we were tuned in
		if (isTunedIn(this.workingDir)) {
			log.logInfo("[tick] presence=here on boot, resuming tick loop");
			this.startTicking();
		}
	}

	async stop(): Promise<void> {
		this.stopTicking();
	}

	// -- Tick lifecycle --

	/**
	 * Start the tick loop. Idempotent. Reads interval from PRESENCE.json.
	 */
	startTicking(): void {
		if (this.timer) {
			// Restart with potentially new interval
			clearInterval(this.timer);
			this.timer = null;
		}
		const intervalMs = getTickIntervalMs(this.workingDir);
		log.logInfo(`[tick] starting loop at ${intervalMs}ms interval`);
		this.timer = setInterval(() => this.fireTick(), intervalMs);
	}

	/**
	 * Stop the tick loop. Idempotent.
	 */
	stopTicking(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			log.logInfo("[tick] stopped loop");
		}
	}

	/**
	 * Called by the internal timer. Skips if not tuned in, or if a previous
	 * tick run is still in flight.
	 */
	private async fireTick(): Promise<void> {
		if (!isTunedIn(this.workingDir)) {
			log.logInfo("[tick] presence=away, stopping loop");
			this.stopTicking();
			return;
		}
		if (this.running) {
			log.logInfo("[tick] previous run still in flight, skipping");
			return;
		}
		const disposition = getTickDisposition(this.workingDir);
		const basePrompt = this.readTickPrompt();
		const dispositionNote =
			disposition === "narrating"
				? "\n\n(Disposition: narrating — owner asked for running updates. The bar for messaging is lower.)"
				: "\n\n(Disposition: quiet — mostly silent. Only reach out if something actually surfaced.)";

		const syntheticEvent: MomEvent = {
			type: "mention",
			channel: TICK_CHANNEL_ID,
			user: "TICK",
			text: `[TICK] ${basePrompt}${dispositionNote}`,
			ts: Date.now().toString(),
		};

		this.running = true;
		try {
			await this.handler.handleEvent(syntheticEvent, this, true);
			// After run completes, check if the agent yielded and record it.
			// wasYielded() is a module-level flag set by yield_no_action.
			const yielded = wasYielded();
			recordTickYield(this.workingDir, this.awarenessDir, yielded);
		} catch (err) {
			log.logWarning("[tick] run failed", err instanceof Error ? err.message : String(err));
		} finally {
			this.running = false;
		}
	}

	// -- enqueueEvent: heartbeat-like headless path --

	enqueueEvent(event: MomEvent): boolean {
		// Tick adapter does not accept external events; it fires its own via the internal timer.
		if (event.channel !== TICK_CHANNEL_ID) return false;
		// If something does enqueue a tick event (e.g. a manual /tick command),
		// fire immediately through the same path. Respect running guard.
		if (this.running) {
			log.logInfo("[tick] enqueueEvent: previous run in flight, discarding");
			return false;
		}
		this.running = true;
		(async () => {
			try {
				await this.handler.handleEvent(event, this, true);
				const yielded = wasYielded();
				recordTickYield(this.workingDir, this.awarenessDir, yielded);
			} catch (err) {
				log.logWarning("[tick] enqueued run failed", err instanceof Error ? err.message : String(err));
			} finally {
				this.running = false;
			}
		})();
		return true;
	}

	// -- Message operations (no-ops — tick is headless) --

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
			channel: `tick:${channel}`,
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
		if (channelId === TICK_CHANNEL_ID) {
			return { id: TICK_CHANNEL_ID, name: "tick" };
		}
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [];
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: TICK_CHANNEL_ID, name: "tick" }];
	}

	// -- Context creation (headless — no platform output) --

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "tick",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: "tick",
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
