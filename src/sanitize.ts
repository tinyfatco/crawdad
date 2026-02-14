/**
 * Sanitize message arrays before sending to the Anthropic API.
 *
 * Fixes corrupted conversation context where tool_result messages
 * exist without a matching tool_use in the preceding assistant message.
 * This can happen when a session is interrupted mid-tool-call.
 */

import * as log from "./log.js";

interface ContentBlock {
	type: string;
	id?: string;
	tool_use_id?: string;
	[key: string]: unknown;
}

interface Message {
	role: string;
	content?: string | ContentBlock[];
	[key: string]: unknown;
}

/**
 * Validate and fix message sequence for Anthropic API compatibility.
 *
 * Rules enforced:
 * - Every toolResult message must have a preceding assistant message
 *   containing a tool_use block with a matching ID
 * - Orphaned toolResult messages are stripped with a warning
 *
 * @returns Sanitized copy of the messages array
 */
export function sanitizeMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let stripped = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Check toolResult messages for matching tool_use
		if (msg.role === "toolResult" || (msg.role === "user" && hasToolResults(msg))) {
			const toolResultIds = getToolResultIds(msg);

			if (toolResultIds.length > 0) {
				// Find the preceding assistant message
				const prevAssistant = findPrecedingAssistant(result);
				const toolUseIds = prevAssistant ? getToolUseIds(prevAssistant) : new Set<string>();

				// Check if all tool_result IDs have matching tool_use
				const allMatched = toolResultIds.every((id) => toolUseIds.has(id));

				if (!allMatched) {
					const orphanedIds = toolResultIds.filter((id) => !toolUseIds.has(id));
					log.logWarning(
						`[sanitize] Stripping message with orphaned tool_result IDs: ${orphanedIds.join(", ")}`,
					);
					stripped++;
					continue; // Skip this message
				}
			}
		}

		result.push(msg);
	}

	if (stripped > 0) {
		log.logWarning(`[sanitize] Stripped ${stripped} message(s) with orphaned tool_results`);
	}

	return result;
}

function hasToolResults(msg: Message): boolean {
	if (!Array.isArray(msg.content)) return false;
	return msg.content.some((block) => block.type === "tool_result");
}

function getToolResultIds(msg: Message): string[] {
	// Handle toolResult role (pi-ai format)
	if (msg.role === "toolResult") {
		const id = (msg as Record<string, unknown>).toolCallId as string | undefined;
		return id ? [id] : [];
	}

	// Handle user messages with tool_result content blocks (Anthropic format)
	if (!Array.isArray(msg.content)) return [];
	return msg.content
		.filter((block) => block.type === "tool_result" && block.tool_use_id)
		.map((block) => block.tool_use_id as string);
}

function findPrecedingAssistant(messages: Message[]): Message | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return null;
}

function getToolUseIds(msg: Message): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(msg.content)) return ids;
	for (const block of msg.content) {
		if (block.type === "tool_use" && block.id) {
			ids.add(block.id);
		}
	}
	return ids;
}
