/**
 * list_channels — list every channel the agent has interacted with.
 *
 * Reads log.jsonl (the agent's unified activity log written by every adapter)
 * and returns the unique set of channels the agent has ever sent or received
 * a message on. This is the source of truth for "what can I send to" because:
 *
 *   - It survives container restarts (log.jsonl lives on R2)
 *   - It captures channels from any adapter, including ones with no
 *     enumerable membership API (Telegram bots, email)
 *   - It's the same data the agent sees in its own awareness stream
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ChannelListing {
	adapter: string;
	id: string;
	name: string;
	lastSeen: string;
}

/**
 * Parse log.jsonl and extract the unique channels the agent has touched.
 *
 * Each log line that has both `channel` and `channelId` represents a real
 * platform interaction. We dedupe by `channelId` and keep the most recent
 * `channel` label and timestamp.
 *
 * The `channel` field is formatted `<adapter>:<name>` (e.g. `telegram:DM:Alex`,
 * `slack:#general`, `email-foo@bar.com`). We split on the first `:` to get
 * the adapter name; everything after is the human-readable label.
 */
export function collectChannelsFromLog(workingDir: string): ChannelListing[] {
	const logPath = join(workingDir, "log.jsonl");
	if (!existsSync(logPath)) return [];

	let raw: string;
	try {
		raw = readFileSync(logPath, "utf-8");
	} catch {
		return [];
	}

	const byId = new Map<string, ChannelListing>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { channel?: string; channelId?: string; date?: string };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const { channel, channelId, date } = entry;
		if (!channel || !channelId) continue;

		// Split "<adapter>:<name>" — email-* has no colon, treat the whole thing as adapter
		const colonIdx = channel.indexOf(":");
		const adapter = colonIdx === -1 ? channel.split("-")[0] : channel.slice(0, colonIdx);
		const name = colonIdx === -1 ? channel : channel.slice(colonIdx + 1);

		const existing = byId.get(channelId);
		if (!existing || (date && date > existing.lastSeen)) {
			byId.set(channelId, { adapter, id: channelId, name, lastSeen: date ?? "" });
		}
	}

	return Array.from(byId.values()).sort((a, b) => {
		if (a.adapter !== b.adapter) return a.adapter.localeCompare(b.adapter);
		return a.name.localeCompare(b.name);
	});
}

/** Format a channel listing as a markdown table for human/agent consumption. */
export function formatChannelTable(channels: ChannelListing[]): string {
	if (channels.length === 0) {
		return "No channels yet — the agent hasn't sent or received any messages.";
	}
	const lines = [
		"| Adapter | Channel ID | Name | Last Seen |",
		"|---------|------------|------|-----------|",
		...channels.map((c) => `| ${c.adapter} | \`${c.id}\` | ${c.name} | ${c.lastSeen || "—"} |`),
	];
	return lines.join("\n");
}

export function createListChannelsTool(workingDir: string): AgentTool<any> {
	const schema = Type.Object({});

	return {
		name: "list_channels",
		label: "list_channels",
		description:
			"List every channel the agent has ever sent or received a message on. " +
			"Reads from log.jsonl, so it covers all adapters (Telegram, Slack, Email, " +
			"Discord, etc.) and survives container restarts. Use this to discover " +
			"valid channel IDs for send_message_to_channel.",
		parameters: schema,
		execute: async () => {
			const channels = collectChannelsFromLog(workingDir);
			return {
				content: [{ type: "text" as const, text: formatChannelTable(channels) }],
				details: undefined,
			};
		},
	};
}
