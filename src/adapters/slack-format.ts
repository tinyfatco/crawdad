// ============================================================================
// Markdown → Slack mrkdwn conversion
// ============================================================================
//
// Slack mrkdwn uses different syntax than standard markdown:
//   bold:   **text** → *text*
//   italic: *text*   → _text_
//   strike: ~~text~~ → ~text~
//   links:  [text](url) → <url|text>
//   headers: # text → *text* (bold, no native headers)
//   blockquotes: > text → > text (Slack supports this natively)
//
// Agents always output markdown regardless of system prompt instructions,
// so we convert at the boundary before sending to the Slack API.

/**
 * Convert markdown text to Slack mrkdwn format.
 *
 * Code blocks and inline code are preserved as-is (Slack uses the same syntax).
 * Safe to call on text that is already valid mrkdwn.
 */
export function markdownToSlackMrkdwn(text: string): string {
	if (!text) return text;

	// Accumulate placeholders and restore at the end
	const placeholders: string[] = [];
	const ph = (content: string): string => {
		const idx = placeholders.length;
		placeholders.push(content);
		return `\x00PH${idx}\x00`;
	};

	let out = text;

	// 1. Extract fenced code blocks (preserve as-is, just strip language identifier)
	out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
		return ph("```\n" + code.replace(/\n$/, "") + "\n```");
	});

	// 2. Extract inline code (preserve as-is)
	out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		return ph("`" + code + "`");
	});

	// 3. Convert markdown constructs (order matters)

	// Links: [text](url) → <url|text>
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText: string, url: string) => {
		return ph(`<${url}|${linkText}>`);
	});

	// Bold+italic: ***text*** → *_text_*
	out = out.replace(/\*{3}(.+?)\*{3}/g, (_match, content: string) => ph(`*_${content}_*`));

	// Bold: **text** → *text*
	// Must extract italic first to avoid **text** eating single * from *italic*
	// Use placeholder to protect converted bold from italic pass
	out = out.replace(/\*{2}(.+?)\*{2}/g, (_match, content: string) => ph(`*${content}*`));
	out = out.replace(/_{2}(.+?)_{2}/g, (_match, content: string) => ph(`*${content}*`));

	// Italic: *text* → _text_ (avoid matching mid-word asterisks)
	out = out.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "_$1_");

	// Strikethrough: ~~text~~ → ~text~
	out = out.replace(/~~(.+?)~~/g, "~$1~");

	// Headers: # text → *text* (bold, all levels, must be at line start)
	out = out.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => ph(`*${content}*`));

	// Unordered list bullets: - item or * item → • item
	// (only at line start, not mid-sentence dashes)
	out = out.replace(/^[-*]\s+/gm, "\u2022 ");

	// 4. Restore placeholders
	out = out.replace(/\x00PH(\d+)\x00/g, (_match, idx: string) => placeholders[Number(idx)]);

	return out;
}
