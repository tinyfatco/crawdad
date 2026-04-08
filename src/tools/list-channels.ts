/**
 * list_channels — list every channel the agent is currently connected to.
 *
 * Returns adapter name, channel ID, and channel name for each channel across
 * all platform adapters. Useful for discovering valid channel IDs to pass to
 * send_message_to_channel.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { PlatformAdapter } from "../adapters/types.js";

export interface ChannelListing {
	adapter: string;
	id: string;
	name: string;
}

/** Build the channel listing — shared by the agent tool and the MCP tool. */
export function collectChannels(adapters: PlatformAdapter[]): ChannelListing[] {
	const out: ChannelListing[] = [];
	for (const adapter of adapters) {
		for (const ch of adapter.getAllChannels()) {
			out.push({ adapter: adapter.name, id: ch.id, name: ch.name });
		}
	}
	return out;
}

/** Format a channel listing as a markdown table for human/agent consumption. */
export function formatChannelTable(channels: ChannelListing[]): string {
	if (channels.length === 0) {
		return "No connected channels.";
	}
	const lines = [
		"| Adapter | Channel ID | Name |",
		"|---------|------------|------|",
		...channels.map((c) => `| ${c.adapter} | \`${c.id}\` | ${c.name} |`),
	];
	return lines.join("\n");
}

export function createListChannelsTool(adapters: PlatformAdapter[]): AgentTool<any> {
	const schema = Type.Object({});

	return {
		name: "list_channels",
		label: "list_channels",
		description:
			"List every channel currently connected across all platform adapters " +
			"(Telegram, Slack, Email, Discord, etc.). Returns a table of adapter, " +
			"channel ID, and channel name. Use this to discover valid channel IDs " +
			"for send_message_to_channel.",
		parameters: schema,
		execute: async () => {
			const channels = collectChannels(adapters);
			return {
				content: [{ type: "text" as const, text: formatChannelTable(channels) }],
				details: undefined,
			};
		},
	};
}
