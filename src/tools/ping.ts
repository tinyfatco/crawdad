/**
 * Cross-channel ping tool.
 *
 * Lets the agent send a message to any connected channel (Telegram, Slack, Email)
 * regardless of which channel the current conversation is on.
 *
 * Routing is by channel ID pattern:
 *   numeric (positive or negative) → Telegram
 *   C/D/G prefix                   → Slack
 *   email-{address}                → Email
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename } from "path";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";

/** Resolve which adapter can handle a given channel ID */
function resolveAdapter(channel: string, adapters: PlatformAdapter[]): PlatformAdapter | undefined {
	// Telegram: numeric (positive or negative)
	if (/^-?\d+$/.test(channel)) {
		return adapters.find((a) => a.name === "telegram");
	}
	// Slack: starts with C, D, or G
	if (/^[CDG]/.test(channel)) {
		return adapters.find((a) => a.name === "slack");
	}
	// Email: starts with "email-" (internal channel ID format)
	if (channel.startsWith("email-")) {
		return adapters.find((a) => a.name === "email");
	}
	return undefined;
}

/**
 * Create the ping tool for cross-channel messaging.
 *
 * @param adapters - All platform adapters available for routing
 */
export function createPingTool(adapters: PlatformAdapter[]): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of what you're sending (shown in logs)" }),
		channel: Type.String({ description: "Channel ID to send to (e.g., Telegram chat ID, Slack channel ID)" }),
		text: Type.String({ description: "Message text to send" }),
		attachments: Type.Optional(Type.Array(Type.String(), { description: "File paths to attach (email only). Each path should be an absolute path to a file on disk." })),
	});

	return {
		name: "ping",
		label: "ping",
		description:
			"Ping a message to a different channel. Use this to reach people on Telegram, Slack, or Email " +
			"when you are currently attending to a different channel. " +
			"The channel ID determines which platform the message goes to: " +
			"numeric IDs → Telegram, C/D/G-prefixed → Slack, email-{address} → Email. " +
			"For email, you can include file attachments (e.g., PDFs, images). " +
			"IMPORTANT: You MUST ping whenever a message arrives from another channel while you are working. " +
			"Never leave a cross-channel message unacknowledged.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			{ channel, text, attachments }: { label: string; channel: string; text: string; attachments?: string[] },
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const adapter = resolveAdapter(channel, adapters);
			if (!adapter) {
				return {
					content: [{ type: "text" as const, text: `No adapter found for channel "${channel}". Available patterns: numeric (Telegram), C/D/G prefix (Slack), email-{address} (Email).` }],
					details: undefined,
				};
			}

			try {
				// Convert file path strings to attachment objects
				const attachmentObjects = attachments?.map((filePath) => ({
					filePath,
					filename: basename(filePath),
				}));

				const ts = await adapter.postMessage(channel, text, attachmentObjects);
				adapter.logBotResponse(channel, text, ts);

				const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
				log.logInfo(`[ping] Sent to ${adapter.name}:${channel}${attInfo}: ${text.substring(0, 80)}`);

				return {
					content: [{ type: "text" as const, text: `Pinged ${adapter.name} channel ${channel}${attInfo} (ts=${ts})` }],
					details: undefined,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[ping] Failed to send to ${adapter.name}:${channel}`, errMsg);
				return {
					content: [{ type: "text" as const, text: `Failed to ping: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
