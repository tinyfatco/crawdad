/**
 * send_message_to_channel — send a message to any connected channel.
 *
 * Lets the agent send a message to any connected channel (Telegram, Slack, Email)
 * regardless of which channel the current conversation is on. Fire and forget —
 * the agent stays where it is.
 *
 * Routing is by channel ID pattern:
 *   numeric (positive or negative) → Telegram
 *   C/D/G prefix                   → Slack
 *   email-{address}                → Email
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { basename } from "path";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";
import type { SendFreshnessGuard } from "../send-freshness-guard.js";

/** Resolve which adapter can handle a given channel ID */
export function resolveAdapter(channel: string, adapters: PlatformAdapter[]): PlatformAdapter | undefined {
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
 * Create the send_message_to_channel tool for cross-channel messaging.
 *
 * @param adapters - All platform adapters available for routing
 */
export function createSendMessageToChannelTool(adapters: PlatformAdapter[], freshnessGuard?: SendFreshnessGuard): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of what you're sending (shown in logs)" }),
		channel: Type.String({ description: "Channel ID to send to (e.g., Telegram chat ID, Slack channel ID, email-user@example.com)" }),
		text: Type.String({ description: "Message text to send" }),
		attachments: Type.Optional(Type.Array(Type.String(), { description: "File paths to attach (email only). Each path should be an absolute path to a file on disk." })),
		subject: Type.Optional(Type.String({ description: "Subject line (email only — ignored for Telegram/Slack/Discord). If omitted while replying inside an active email conversation, the current thread subject is reused." })),
	});

	return {
		name: "send_message_to_channel",
		label: "send_message_to_channel",
		description:
			"Send a message to a channel without moving there. Use this to reach people on Telegram, Slack, or Email " +
			"while staying focused on your current channel. " +
			"The channel ID determines which platform the message goes to: " +
			"numeric IDs → Telegram, C/D/G-prefixed → Slack, email-{address} → Email. " +
			"For email, you can include file attachments (e.g., PDFs, images) and an optional subject line. " +
			"If you use this during an active email conversation and send back to that same email channel, the adapter preserves reply threading and adds a native-style quoted reply block automatically. " +
			"IMPORTANT: You MUST send a message whenever a cross-channel message arrives while you are working. " +
			"Never leave a cross-channel message unacknowledged.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
		) => {
			const { channel, text, attachments, subject } = params as {
				label: string;
				channel: string;
				text: string;
				attachments?: string[];
				subject?: string;
			};
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

				// Re-check immediately before the external side effect so explicit stop
				// can suppress stale outbound text.
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const freshness = freshnessGuard?.checkCanSend();
				if (freshness && !freshness.ok) {
					const reason = freshness.reason || "A newer inbound message has not been incorporated yet.";
					log.logInfo(`[send_message_to_channel] Suppressed stale send to ${adapter.name}:${channel}: ${reason}`);
					return {
						content: [{ type: "text" as const, text: `Message not sent: ${reason} Incorporate the latest message first, then decide whether to send.` }],
						details: undefined,
						terminate: true,
					};
				}

				const ts = await adapter.postMessage(channel, text, attachmentObjects, subject);
				adapter.logBotResponse(channel, text, ts);

				const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
				log.logInfo(`[send_message_to_channel] Sent to ${adapter.name}:${channel}${attInfo}: ${text.substring(0, 80)}`);

				return {
					content: [{ type: "text" as const, text: `Message sent to ${adapter.name} channel ${channel}${attInfo} (ts=${ts})` }],
					details: undefined,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[send_message_to_channel] Failed to send to ${adapter.name}:${channel}`, errMsg);
				return {
					content: [{ type: "text" as const, text: `Failed to send message: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
