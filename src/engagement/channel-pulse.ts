/**
 * ChannelPulse — lightweight activity tracker for ambient engagement.
 *
 * Maintains a ring buffer of recent messages per channel. No LLM calls,
 * no async, no distinction between bots and humans — everyone is just
 * a participant. The pulse gives the engagement system the raw signal
 * it needs to decide when to invoke the LLM for a "should I speak?" check.
 */

export interface PulseEntry {
	ts: number; // Date.now() millis
	participantId: string;
	textLength: number;
	/** First ~300 chars of message text, for ambient context. */
	text?: string;
}

const BUFFER_SIZE = 50;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export class ChannelPulse {
	private buffers = new Map<string, PulseEntry[]>();
	private selfId: string;

	constructor(selfId: string) {
		this.selfId = selfId;
	}

	/** Update selfId after auth resolves the bot user ID. */
	setSelfId(id: string): void {
		this.selfId = id;
	}

	/** Record a message in a channel. Call on every incoming event, before any filtering. */
	record(channelId: string, participantId: string, textLength: number, text?: string): void {
		let buf = this.buffers.get(channelId);
		if (!buf) {
			buf = [];
			this.buffers.set(channelId, buf);
		}
		buf.push({ ts: Date.now(), participantId, textLength, text: text?.substring(0, 300) });
		// Ring buffer: trim from front
		if (buf.length > BUFFER_SIZE) {
			buf.splice(0, buf.length - BUFFER_SIZE);
		}
	}

	/** Recent messages within a time window, capped. For ambient context. */
	recentMessages(channelId: string, windowMs = 5 * 60 * 1000, maxCount = 15): PulseEntry[] {
		const buf = this.buffers.get(channelId);
		if (!buf) return [];
		const cutoff = Date.now() - windowMs;
		const recent = buf.filter((e) => e.ts > cutoff && e.text);
		// Deduplicate by text content (same message might arrive via multiple event types)
		const seen = new Set<string>();
		const deduped: PulseEntry[] = [];
		for (const entry of recent) {
			const key = `${entry.participantId}:${entry.text}`;
			if (!seen.has(key)) {
				seen.add(key);
				deduped.push(entry);
			}
		}
		return deduped.slice(-maxCount);
	}

	/** Messages in the last 15-minute window. */
	temperature(channelId: string): number {
		const buf = this.buffers.get(channelId);
		if (!buf) return 0;
		const cutoff = Date.now() - WINDOW_MS;
		return buf.filter((e) => e.ts > cutoff).length;
	}

	/** Milliseconds since this bot last spoke in the channel. Infinity if never. */
	timeSinceMyLast(channelId: string): number {
		const buf = this.buffers.get(channelId);
		if (!buf) return Infinity;
		for (let i = buf.length - 1; i >= 0; i--) {
			if (buf[i].participantId === this.selfId) {
				return Date.now() - buf[i].ts;
			}
		}
		return Infinity;
	}

	/** Number of unique participants in the recent window. */
	recentParticipantCount(channelId: string): number {
		const buf = this.buffers.get(channelId);
		if (!buf) return 0;
		const cutoff = Date.now() - WINDOW_MS;
		const ids = new Set<string>();
		for (const e of buf) {
			if (e.ts > cutoff) ids.add(e.participantId);
		}
		return ids.size;
	}

	/** Last N entries for a channel (oldest first). */
	lastEntries(channelId: string, n = 10): PulseEntry[] {
		const buf = this.buffers.get(channelId);
		if (!buf) return [];
		return buf.slice(-n);
	}

	/** Quick summary for logging / LLM context. */
	summary(channelId: string): {
		temperature: number;
		timeSinceMyLastMs: number;
		recentParticipants: number;
		bufferSize: number;
	} {
		return {
			temperature: this.temperature(channelId),
			timeSinceMyLastMs: this.timeSinceMyLast(channelId),
			recentParticipants: this.recentParticipantCount(channelId),
			bufferSize: this.buffers.get(channelId)?.length ?? 0,
		};
	}
}
