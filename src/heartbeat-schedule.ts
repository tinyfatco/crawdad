/**
 * Heartbeat schedule writer — translates `settings.spontaneity` into
 * `events/heartbeat.json` so the EventsWatcher picks up the new cadence.
 *
 * Previously inlined in `main.ts` boot sequence. Extracted so the Agency
 * MCP operator intake can call it after `configure spontaneity.*` edits,
 * giving live reschedule instead of "effect on next boot".
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { HEARTBEAT_CHANNEL_ID } from "./adapters/heartbeat.js";
import type { MomSpontaneitySettings } from "./context.js";
import * as log from "./log.js";

export interface HeartbeatScheduleResult {
	/** Whether a heartbeat.json file now exists on disk. */
	enabled: boolean;
	/** Path written (or removed). */
	path: string;
	/** Cron schedule string, if enabled. */
	schedule?: string;
	/** IANA timezone used, if enabled. */
	timezone?: string;
}

/**
 * Translate spontaneity settings into a periodic event file.
 *
 * - If `enabled`, writes `events/heartbeat.json` with a cron + jitter + quiet hours.
 * - If disabled, removes `events/heartbeat.json` if present.
 *
 * Safe to call repeatedly. Caller is responsible for triggering any wake
 * manifest resync (the EventsWatcher picks up the file change via inotify).
 */
export function syncHeartbeatFromSpontaneity(
	workingDir: string,
	spontaneity: MomSpontaneitySettings,
): HeartbeatScheduleResult {
	const eventsDir = join(workingDir, "events");
	const heartbeatFile = join(eventsDir, "heartbeat.json");

	if (!spontaneity.enabled) {
		if (existsSync(heartbeatFile)) {
			unlinkSync(heartbeatFile);
			log.logInfo("Removed heartbeat.json (spontaneity disabled)");
		}
		return { enabled: false, path: heartbeatFile };
	}

	if (!existsSync(eventsDir)) {
		mkdirSync(eventsDir, { recursive: true });
	}

	const tz =
		spontaneity.timezone ||
		Intl.DateTimeFormat().resolvedOptions().timeZone;

	// Convert interval minutes to valid cron (minutes field only supports 0-59).
	const mins = spontaneity.intervalMinutes;
	let schedule: string;
	if (mins < 60) {
		schedule = `*/${mins} * * * *`;
	} else if (mins < 1440) {
		const hours = Math.max(1, Math.round(mins / 60));
		schedule = `0 */${hours} * * *`;
	} else {
		schedule = `0 8 * * *`; // daily at 8am
	}

	const event = {
		type: "periodic",
		channelId: HEARTBEAT_CHANNEL_ID,
		text: "[heartbeat] Spontaneous reflection",
		schedule,
		timezone: tz,
		spontaneity: spontaneity.spontaneity,
		quietHours: spontaneity.quietHours,
	};

	writeFileSync(heartbeatFile, JSON.stringify(event, null, 2), "utf-8");
	log.logInfo(
		`Wrote heartbeat.json (every ${mins}min, spontaneity=${spontaneity.spontaneity}, tz=${tz})`,
	);

	return { enabled: true, path: heartbeatFile, schedule, timezone: tz };
}
