// ============================================================================
// Markdown → Telegram HTML conversion
// ============================================================================
//
// Telegram HTML supports only: <b> <i> <u> <s> <code> <pre> <a href="">
// Agents always output markdown regardless of system prompt instructions,
// so we convert at the boundary before sending to the Telegram API.

/** HTML-escape the 3 special characters */
function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Safe to call on text that is already valid Telegram HTML — existing tags
 * are preserved via placeholder extraction before any escaping happens.
 */
export function markdownToTelegramHtml(text: string): string {
	// Accumulate placeholders and restore at the end
	const placeholders: string[] = [];
	const ph = (content: string): string => {
		const idx = placeholders.length;
		placeholders.push(content);
		return `\x00PH${idx}\x00`;
	};

	let out = text;

	// 1. Preserve existing HTML tags (so already-valid Telegram HTML passes through)
	//    Match opening/closing/self-closing tags for the 7 supported elements.
	out = out.replace(
		/<(\/?)(?:b|i|u|s|code|pre|a)((?:\s+[^>]*)?)>/gi,
		(match) => ph(match),
	);

	// 2. Extract fenced code blocks — contents get HTML-escaped but no markdown processing
	out = out.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code: string) => {
		return ph(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
	});

	// 3. Extract inline code — same treatment
	out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		return ph(`<code>${esc(code)}</code>`);
	});

	// 4. HTML-escape all remaining plain text
	out = esc(out);

	// 5. Convert markdown constructs (order matters)

	// Links: [text](url)
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	// Bold+italic: ***text*** or ___text___
	out = out.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");
	out = out.replace(/_{3}(.+?)_{3}/g, "<b><i>$1</i></b>");

	// Bold: **text** or __text__
	out = out.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
	out = out.replace(/_{2}(.+?)_{2}/g, "<b>$1</b>");

	// Italic: *text* or _text_ (avoid matching mid-word underscores like foo_bar_baz)
	out = out.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
	out = out.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

	// Strikethrough: ~~text~~
	out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Headers: # text → bold (all levels, must be at line start)
	out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

	// Blockquotes: > text → italic (strip the >)
	out = out.replace(/^&gt;\s?(.*)$/gm, "<i>$1</i>");

	// Unordered list bullets: - item or * item → • item
	out = out.replace(/^[-*]\s+/gm, "• ");

	// 6. Restore placeholders
	out = out.replace(/\x00PH(\d+)\x00/g, (_match, idx: string) => placeholders[Number(idx)]);

	return out;
}
