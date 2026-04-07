/**
 * Presence — the agent's tune_in / tune_out state.
 *
 * Backed by PRESENCE.json in the workspace root. Readable/writable by the
 * agent itself (it's just a file). Controls whether the TickAdapter fires.
 *
 * Heartbeat is NOT gated by presence — it fires in both states. Only the
 * high-frequency ambient tick loop is gated.
 *
 * See memory-bank/03-design/presence-and-ticks.md for the full design.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import * as log from "./log.js";

export type PresenceState = "here" | "away";
export type TickDisposition = "quiet" | "narrating";
export type TickInterval = "1m" | "2m" | "2.5m" | "5m" | "10m";

export interface Presence {
	state: PresenceState;
	since: string;
	reason?: string;
	interval?: TickInterval;
	disposition?: TickDisposition;
	consecutive_yields?: number;
}

/** Default tick interval if none is set. */
const DEFAULT_INTERVAL: TickInterval = "5m";
/** Default disposition if none is set. */
const DEFAULT_DISPOSITION: TickDisposition = "quiet";
/** Auto-tune-out threshold — consecutive yields before forcing tune_out. */
export const AUTO_TUNE_OUT_THRESHOLD = 20;

const PRESENCE_FILE = "PRESENCE.json";

function presencePath(workingDir: string): string {
	return join(workingDir, PRESENCE_FILE);
}

/**
 * Read PRESENCE.json. Returns a default "away" state if the file is missing
 * or malformed. Never throws.
 */
export function readPresence(workingDir: string): Presence {
	const filePath = presencePath(workingDir);
	if (!existsSync(filePath)) {
		return { state: "away", since: new Date(0).toISOString() };
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<Presence>;
		if (parsed.state !== "here" && parsed.state !== "away") {
			return { state: "away", since: new Date(0).toISOString() };
		}
		return {
			state: parsed.state,
			since: parsed.since || new Date().toISOString(),
			reason: parsed.reason,
			interval: parsed.interval,
			disposition: parsed.disposition,
			consecutive_yields: parsed.consecutive_yields ?? 0,
		};
	} catch (err) {
		log.logWarning("Failed to read PRESENCE.json, defaulting to away", String(err));
		return { state: "away", since: new Date(0).toISOString() };
	}
}

/**
 * Write PRESENCE.json atomically. Silent on failure (logs warning).
 */
export function writePresence(workingDir: string, presence: Presence): void {
	const filePath = presencePath(workingDir);
	try {
		writeFileSync(filePath, JSON.stringify(presence, null, 2), "utf-8");
	} catch (err) {
		log.logWarning("Failed to write PRESENCE.json", String(err));
	}
}

export function isTunedIn(workingDir: string): boolean {
	return readPresence(workingDir).state === "here";
}

/**
 * Parse a TickInterval string into milliseconds.
 */
export function intervalToMs(interval: TickInterval | undefined): number {
	switch (interval) {
		case "1m":
			return 60_000;
		case "2m":
			return 120_000;
		case "2.5m":
			return 150_000;
		case "5m":
			return 300_000;
		case "10m":
			return 600_000;
		default:
			return intervalToMs(DEFAULT_INTERVAL);
	}
}

export function getTickIntervalMs(workingDir: string): number {
	const p = readPresence(workingDir);
	return intervalToMs(p.interval);
}

export function getTickDisposition(workingDir: string): TickDisposition {
	return readPresence(workingDir).disposition ?? DEFAULT_DISPOSITION;
}

/**
 * Append a presence transition line to the awareness context.jsonl.
 * The agent sees these on its next run.
 */
export function appendAwarenessLine(awarenessDir: string, line: string): void {
	const contextFile = join(awarenessDir, "context.jsonl");
	try {
		const entry = {
			type: "message",
			id: randomUUID().substring(0, 8),
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: `[${new Date().toISOString()}] [presence] [system]: ${line}` }],
			},
		};
		appendFileSync(contextFile, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		log.logWarning("Failed to append presence awareness line", String(err));
	}
}

/**
 * Tune in. Writes PRESENCE.json, appends awareness line, returns the new state.
 */
export function tuneIn(
	workingDir: string,
	awarenessDir: string,
	opts: { reason: string; interval?: TickInterval; disposition?: TickDisposition },
): Presence {
	const presence: Presence = {
		state: "here",
		since: new Date().toISOString(),
		reason: opts.reason,
		interval: opts.interval ?? DEFAULT_INTERVAL,
		disposition: opts.disposition ?? DEFAULT_DISPOSITION,
		consecutive_yields: 0,
	};
	writePresence(workingDir, presence);
	appendAwarenessLine(
		awarenessDir,
		`[PRESENCE] tuned in (${presence.interval}, ${presence.disposition}): ${opts.reason}`,
	);
	log.logInfo(`[presence] tuned in: ${opts.reason} (${presence.interval}, ${presence.disposition})`);
	return presence;
}

/**
 * Tune out. Writes PRESENCE.json, appends awareness line.
 */
export function tuneOut(
	workingDir: string,
	awarenessDir: string,
	opts: { reason: string; auto?: boolean },
): Presence {
	const presence: Presence = {
		state: "away",
		since: new Date().toISOString(),
		reason: opts.reason,
		consecutive_yields: 0,
	};
	writePresence(workingDir, presence);
	const prefix = opts.auto ? "[PRESENCE] tuned out (auto)" : "[PRESENCE] tuned out";
	appendAwarenessLine(awarenessDir, `${prefix}: ${opts.reason}`);
	log.logInfo(`[presence] tuned out${opts.auto ? " (auto)" : ""}: ${opts.reason}`);
	return presence;
}

/**
 * Record the outcome of a tick run. If the agent yielded (no action),
 * increment the counter. If it did anything else, reset the counter.
 * Triggers auto-tune-out at AUTO_TUNE_OUT_THRESHOLD consecutive yields.
 *
 * Returns true if an auto-tune-out was triggered.
 */
export function recordTickYield(
	workingDir: string,
	awarenessDir: string,
	yielded: boolean,
): boolean {
	const current = readPresence(workingDir);
	if (current.state !== "here") return false;

	if (!yielded) {
		if ((current.consecutive_yields ?? 0) !== 0) {
			writePresence(workingDir, { ...current, consecutive_yields: 0 });
		}
		return false;
	}

	const nextCount = (current.consecutive_yields ?? 0) + 1;
	if (nextCount >= AUTO_TUNE_OUT_THRESHOLD) {
		tuneOut(workingDir, awarenessDir, {
			reason: `auto after ${nextCount} quiet ticks`,
			auto: true,
		});
		return true;
	}
	writePresence(workingDir, { ...current, consecutive_yields: nextCount });
	return false;
}
