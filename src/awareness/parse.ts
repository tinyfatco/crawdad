/**
 * Node-side parser for awareness/context.jsonl lines.
 *
 * Mirrors the UI parser in ui/src/types.ts. The two packages have disjoint
 * tsconfig rootDirs, so the parser is duplicated rather than shared. Keep
 * the two copies in sync if the schema evolves.
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultContent {
	type: "toolResult";
	toolCallId: string;
	result: string;
	isError?: boolean;
}

export type ContentBlock = TextContent | ThinkingContent | ToolCallContent | ToolResultContent;

export interface AwarenessEntry {
	id: string;
	type: "session" | "message";
	timestamp: string;
	role?: "user" | "assistant" | "toolResult";
	content?: ContentBlock[];
	channel?: string;
	userName?: string;
	strippedText?: string;
	model?: string;
	stopReason?: string;
	isAmbient?: boolean;
	isSystemAction?: boolean;
}

/** Parse the [timestamp] [channel] [user]: text prefix from user messages */
export function parseUserPrefix(
	text: string,
): { channel: string; userName: string; strippedText: string } | null {
	const match = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
	if (!match) return null;
	return { channel: match[2], userName: match[3], strippedText: match[4] };
}

/** Parse a single JSON line from context.jsonl into an AwarenessEntry */
export function parseContextLine(line: string): AwarenessEntry | null {
	try {
		const raw = JSON.parse(line);

		if (raw.type === "session") {
			return {
				id: raw.id || `session-${raw.timestamp}`,
				type: "session",
				timestamp: raw.timestamp,
			};
		}

		if (raw.type === "message" && raw.message) {
			const msg = raw.message;
			const entry: AwarenessEntry = {
				id: raw.id || `msg-${raw.timestamp}`,
				type: "message",
				timestamp: raw.timestamp,
				role: msg.role,
				content: msg.content,
				model: raw.model,
				stopReason: raw.stopReason,
			};

			if (msg.role === "user" && Array.isArray(msg.content)) {
				const textBlock = msg.content.find(
					(c: ContentBlock) => c.type === "text",
				) as TextContent | undefined;
				if (textBlock) {
					const cleaned = textBlock.text
						.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, "")
						.trim();
					const parsed = parseUserPrefix(cleaned);
					if (parsed) {
						entry.channel = parsed.channel;
						entry.userName = parsed.userName;
						entry.strippedText = parsed.strippedText;
						if (parsed.strippedText.startsWith("[AMBIENT]")) {
							entry.isAmbient = true;
							entry.userName = "system";
						}
						if (parsed.userName === "system" && parsed.strippedText.startsWith("/")) {
							entry.isSystemAction = true;
						}
					} else if (cleaned !== textBlock.text) {
						entry.strippedText = cleaned;
					}
				}
			}

			return entry;
		}
	} catch {
		// Malformed line
	}
	return null;
}
