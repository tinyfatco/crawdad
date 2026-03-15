// ============================================================================
// Markdown → Discord markdown conversion
// ============================================================================
//
// Discord uses standard markdown natively: **bold**, *italic*, ~~strike~~,
// `code`, ```blocks```, [text](url). Near-passthrough — agents already
// output standard markdown.
//
// Only strip Discord-specific mention syntax from incoming messages.

/**
 * Convert markdown to Discord format.
 * Discord supports standard markdown, so this is essentially a passthrough.
 */
export function markdownToDiscordMarkdown(text: string): string {
	return text;
}

/**
 * Strip Discord mention syntax from incoming message text.
 * <@userId> → empty, <#channelId> → empty, <@&roleId> → empty
 */
export function stripDiscordMentions(text: string): string {
	return text.replace(/<@[!&]?\d+>/g, "").replace(/<#\d+>/g, "").trim();
}
