/**
 * move_to_channel — move to a different channel.
 *
 * When called, the harness routes all subsequent output to the specified channel.
 * The agent is effectively "moving" to that channel — future responses appear there.
 *
 * Use this when you want to shift your focus to another channel, e.g. after
 * receiving a cross-channel message that needs your full attention there,
 * or during a heartbeat when you want to reach out on Slack/Telegram/Email.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";

/**
 * Create the move_to_channel tool.
 *
 * @param adapters - All platform adapters (used to resolve channel names)
 * @param onMove - Callback invoked when the agent moves. Returns the resolved channel name.
 */
export function createMoveToChannelTool(
	adapters: PlatformAdapter[],
	onMove: (channelId: string) => string | undefined,
): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description shown in logs" }),
		channel: Type.String({
			description: "Channel ID to move to (Slack: C09V58YMJGP or #general, Telegram: numeric chat ID, Email: email-addr)",
		}),
	});

	return {
		name: "move_to_channel",
		label: "move_to_channel",
		description:
			"Move to a different channel. Your subsequent text responses will be delivered to that channel. " +
			"Works across all adapters: Slack (C/D/G IDs or #name), Telegram (numeric chat IDs), Email (email-addr). " +
			"Use this when you want to move your focus — e.g., after receiving a cross-channel message " +
			"that needs your full attention there, or during a heartbeat to reach out on a specific channel.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			{ channel }: { label: string; channel: string },
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Resolve channel name to ID if given a #name (Slack shorthand)
			let resolvedChannelId = channel;
			if (channel.startsWith("#")) {
				const name = channel.slice(1);
				for (const adapter of adapters) {
					const found = adapter.getAllChannels().find((c) => c.name === name);
					if (found) {
						resolvedChannelId = found.id;
						break;
					}
				}
				if (resolvedChannelId === channel) {
					const allChannels = adapters.flatMap((a) => a.getAllChannels());
					return {
						content: [{ type: "text" as const, text: `Channel #${name} not found. Available: ${allChannels.map(c => `${c.name} (${c.id})`).join(", ")}` }],
						details: undefined,
					};
				}
			}

			const channelName = onMove(resolvedChannelId);
			if (channelName === undefined) {
				return {
					content: [{ type: "text" as const, text: `Channel ${resolvedChannelId} not found across any adapter.` }],
					details: undefined,
				};
			}

			log.logInfo(`[move_to_channel] Moved to ${channelName} (${resolvedChannelId})`);

			return {
				content: [{ type: "text" as const, text: `Moved to ${channelName} (${resolvedChannelId}). Your next responses will appear there.` }],
				details: undefined,
			};
		},
	};
}
