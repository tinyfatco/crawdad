import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, statSync, unlinkSync, watch } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { MomEvent as MomIncomingEvent, PlatformAdapter } from "./adapters/types.js";
import * as log from "./log.js";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
	type: "immediate";
	channelId: string;
	text: string;
}

export interface OneShotEvent {
	type: "one-shot";
	channelId: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
	type: "periodic";
	channelId: string;
	text: string;
	schedule: string; // cron syntax
	timezone: string; // IANA timezone
}

export type ScheduledEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
/** Grace window for past-due one-shot events (10 minutes). Covers cold-start delay. */
const COLD_WAKE_GRACE_MS = 10 * 60 * 1000;

export class EventsWatcher {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private knownFiles: Set<string> = new Set();

	constructor(
		private eventsDir: string,
		private adapters: PlatformAdapter[],
	) {
		this.startTime = Date.now();
	}

	/**
	 * Start watching for events. Call this after adapter is ready.
	 */
	start(): void {
		// Ensure events directory exists
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

		// Watch for changes immediately (fast)
		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename || !filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});

		// Scan existing files ASYNC — don't block the event loop.
		// On slow filesystems (s3fs/FUSE), readdir can take 60+ seconds.
		this.scanExistingAsync().then(() => {
			log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
		});
	}

	/**
	 * Stop watching and cancel all scheduled events.
	 */
	stop(): void {
		// Stop fs watcher
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		// Cancel all debounce timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Cancel all scheduled timers
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		// Cancel all cron jobs
		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		this.knownFiles.clear();
		log.logInfo("Events watcher stopped");
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private async scanExistingAsync(): Promise<void> {
		let files: string[];
		try {
			files = (await readdir(this.eventsDir)).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning("Failed to read events directory", String(err));
			return;
		}

		for (const filename of files) {
			this.handleFile(filename);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			// File was deleted
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			// File was modified - cancel existing and re-schedule
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			// New file
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;

		log.logInfo(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// Parse with retries
		let event: ScheduledEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.parseEvent(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) {
					await this.sleep(RETRY_BASE_MS * 2 ** i);
				}
			}
		}

		if (!event) {
			log.logWarning(`Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`, lastError?.message);
			this.deleteFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		// Schedule based on type
		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): ScheduledEvent | null {
		const data = JSON.parse(content);

		if (!data.type || !data.channelId || !data.text) {
			throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
		}

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text };

			case "one-shot":
				if (!data.at) {
					throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
				}
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at };

			case "periodic":
				if (!data.schedule) {
					throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
				}
				if (!data.timezone) {
					throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
				}
				return {
					type: "periodic",
					channelId: data.channelId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	private handleImmediate(filename: string, event: ImmediateEvent): void {
		const filePath = join(this.eventsDir, filename);

		// Check if stale (created before harness started)
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.logInfo(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			// File may have been deleted
			return;
		}

		log.logInfo(`Executing immediate event: ${filename}`);
		this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (atTime <= now) {
			const ageMs = now - atTime;
			if (ageMs <= COLD_WAKE_GRACE_MS) {
				// Past but within grace window — execute immediately.
				// Covers cold-start delay where container boots after the event's target time.
				log.logInfo(`One-shot event ${Math.round(ageMs / 1000)}s past due (within grace window), executing: ${filename}`);
				this.execute(filename, event);
				return;
			}
			// Too old — discard
			log.logInfo(`One-shot event ${Math.round(ageMs / 1000)}s past due (beyond grace window), deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}

		const delay = atTime - now;
		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);

		const timer = setTimeout(() => {
			this.timers.delete(filename);
			log.logInfo(`Executing one-shot event: ${filename}`);
			this.execute(filename, event);
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				log.logInfo(`Executing periodic event: ${filename}`);
				this.execute(filename, event, false); // Don't delete periodic events
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.deleteFile(filename);
		}
	}

	private execute(filename: string, event: ScheduledEvent, deleteAfter: boolean = true): void {
		// Format the message
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		// Create synthetic event
		const syntheticEvent: MomIncomingEvent = {
			type: "mention",
			channel: event.channelId,
			user: "EVENT",
			text: message,
			ts: Date.now().toString(),
		};

		// Enqueue for processing — try each adapter until one accepts
		let enqueued = false;
		for (const adapter of this.adapters) {
			if (adapter.enqueueEvent(syntheticEvent)) {
				enqueued = true;
				break;
			}
		}

		if (enqueued && deleteAfter) {
			// Delete file after successful enqueue (immediate and one-shot)
			this.deleteFile(filename);
		} else if (!enqueued) {
			log.logWarning(`Event queue full, discarded: ${filename}`);
			// Still delete immediate/one-shot even if discarded
			if (deleteAfter) {
				this.deleteFile(filename);
			}
		}
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			// ENOENT is fine (file already deleted), other errors are warnings
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create and start an events watcher.
 */
export function createEventsWatcher(workspaceDir: string, adapters: PlatformAdapter[]): EventsWatcher {
	const eventsDir = join(workspaceDir, "events");
	return new EventsWatcher(eventsDir, adapters);
}

// ============================================================================
// Exported schedule helpers (used by gateway /schedule endpoint)
// ============================================================================

/**
 * Parse a raw JSON string into a ScheduledEvent.
 * Returns null if the content is invalid.
 */
export function parseEventContent(content: string): ScheduledEvent | null {
	try {
		const data = JSON.parse(content);
		if (!data.type || !data.channelId || !data.text) return null;

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text };
			case "one-shot":
				if (!data.at) return null;
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at };
			case "periodic":
				if (!data.schedule || !data.timezone) return null;
				return { type: "periodic", channelId: data.channelId, text: data.text, schedule: data.schedule, timezone: data.timezone };
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/**
 * Compute the full wake manifest for scheduled events.
 * Returns ALL event timestamps with stable IDs (filenames) — no event content.
 * The orchestrator stores these durably to schedule container wakes.
 * `nextWake` is derived (earliest timestamp) for backwards compat.
 */
export async function computeWakeManifest(eventsDir: string): Promise<{
	nextWake: string | null;
	events: Array<{ file: string; type: string; nextFire: string }>;
}> {
	const result: Array<{ file: string; type: string; nextFire: string }> = [];

	if (!existsSync(eventsDir)) {
		return { nextWake: null, events: [] };
	}

	let files: string[];
	try {
		files = (await readdir(eventsDir)).filter((f) => f.endsWith(".json"));
	} catch {
		return { nextWake: null, events: [] };
	}

	for (const filename of files) {
		try {
			const content = await readFile(join(eventsDir, filename), "utf-8");
			const event = parseEventContent(content);
			if (!event) continue;

			if (event.type === "periodic") {
				try {
					const cron = new Cron(event.schedule, { timezone: event.timezone });
					const next = cron.nextRun();
					if (next) {
						result.push({ file: filename, type: "periodic", nextFire: next.toISOString() });
					}
				} catch {
					// Invalid cron — skip
				}
			} else if (event.type === "one-shot") {
				const at = new Date(event.at);
				if (at.getTime() > Date.now()) {
					result.push({ file: filename, type: "one-shot", nextFire: at.toISOString() });
				}
			}
			// Skip immediate events — they fire on creation, not on schedule
		} catch {
			// Skip unreadable files
		}
	}

	// Find earliest next fire time
	let earliest: string | null = null;
	for (const e of result) {
		if (!earliest || e.nextFire < earliest) {
			earliest = e.nextFire;
		}
	}

	return { nextWake: earliest, events: result };
}
