export interface EmailReplyQuote {
	body: string;
	from?: string;
	sentAt?: string;
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseSender(sender?: string): string {
	const trimmed = sender?.trim();
	if (!trimmed) return "someone";

	const angleMatch = trimmed.match(/^(.*?)(?:\s*<([^>]+)>)\s*$/);
	if (!angleMatch) return trimmed;

	const displayName = angleMatch[1]?.trim().replace(/^"|"$/g, "");
	const email = angleMatch[2]?.trim();
	if (displayName && email) return `${displayName} <${email}>`;
	return email || trimmed;
}

function formatQuoteHeader(from?: string, sentAt?: string): string {
	const sender = parseSender(from);
	if (!sentAt) return `On ${sender} wrote:`;

	const date = new Date(sentAt);
	if (Number.isNaN(date.getTime())) return `On ${sender} wrote:`;

	const datePart = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
	const timePart = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);

	return `On ${datePart} at ${timePart}, ${sender} wrote:`;
}

function quoteBody(body: string): string {
	return normalizeNewlines(body)
		.trim()
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

export function composeEmailReplyBody(finalText: string, quote?: EmailReplyQuote | null): string {
	const main = normalizeNewlines(finalText).trim();
	if (!quote?.body?.trim()) return main;

	return `${main}\n\n${formatQuoteHeader(quote.from, quote.sentAt)}\n${quoteBody(quote.body)}`;
}
