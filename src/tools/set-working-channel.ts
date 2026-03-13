/**
 * set_working_channel tool.
 *
 * Lets the agent explicitly shift its attention to a different Slack channel.
 * When called, the harness will route subsequent output to the specified channel.
 *
 * This is a trunk-only tool — only meaningful when the agent has unified
 * consciousness across multiple Slack channels.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";

/**
 * Create the set_working_channel tool for attention shifting.
 *
 * @param adapters - All platform adapters (used to resolve channel names)
 * @param onShift - Callback invoked when the agent shifts attention. Returns the resolved channel name.
 */
export function createSetWorkingChannelTool(
	adapters: PlatformAdapter[],
	onShift: (channelId: string) => string | undefined,
): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description shown in logs" }),
		channel: Type.String({
			description: "Slack channel ID (e.g., C09V58YMJGP) or channel name (e.g., #general) to shift attention to",
		}),
	});

	return {
		name: "set_working_channel",
		label: "set_working_channel",
		description:
			"Shift your attention to a different Slack channel. Your subsequent text responses will be delivered to that channel. " +
			"Use this when you want to move your focus — e.g., after receiving a cross-channel message that needs your full attention there.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			{ channel }: { label: string; channel: string },
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Resolve channel name to ID if given a #name
			let resolvedChannelId = channel;
			if (channel.startsWith("#")) {
				const name = channel.slice(1);
				const slackAdapter = adapters.find((a) => a.name === "slack");
				if (slackAdapter) {
					const found = slackAdapter.getAllChannels().find((c) => c.name === name);
					if (found) {
						resolvedChannelId = found.id;
					} else {
						return {
							content: [{ type: "text" as const, text: `Channel #${name} not found. Available channels: ${slackAdapter.getAllChannels().map(c => `#${c.name} (${c.id})`).join(", ")}` }],
							details: undefined,
						};
					}
				}
			}

			const channelName = onShift(resolvedChannelId);
			if (channelName === undefined) {
				return {
					content: [{ type: "text" as const, text: `Channel ${resolvedChannelId} not found or not a Slack channel.` }],
					details: undefined,
				};
			}

			log.logInfo(`[set_working_channel] Attention shifted to #${channelName} (${resolvedChannelId})`);

			return {
				content: [{ type: "text" as const, text: `Attention shifted to #${channelName} (${resolvedChannelId}). Your next responses will appear there.` }],
				details: undefined,
			};
		},
	};
}
