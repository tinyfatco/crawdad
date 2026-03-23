/**
 * browser_content — extract readable content from a URL as markdown.
 * Uses Readability + Turndown for clean extraction.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Readability } from "@mozilla/readability";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
// @ts-ignore no types available
import { gfm } from "turndown-plugin-gfm";
import { getActivePage } from "./manager.js";

const schema = Type.Object({
	url: Type.String({ description: "URL to extract content from" }),
});

function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	return turndown
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function createBrowserContentTool(): AgentTool<typeof schema> {
	return {
		name: "browser_content",
		label: "browser",
		description:
			"Navigate to a URL and extract its readable content as clean markdown. Uses Mozilla Readability for article extraction. Good for reading articles, docs, and web pages.",
		parameters: schema,
		execute: async (_toolCallId: string, { url }: { url: string }) => {
			const page = await getActivePage();

			await Promise.race([
				page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }),
				new Promise((r) => setTimeout(r, 15000)),
			]).catch(() => {});

			// Get HTML via CDP (works with TrustedScriptURL restrictions)
			const client = await page.createCDPSession();
			const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
			const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId: root.nodeId });
			await client.detach();

			const finalUrl = page.url();

			// Extract with Readability
			const doc = new JSDOM(outerHTML, { url: finalUrl });
			const reader = new Readability(doc.window.document);
			const article = reader.parse();

			let content: string;
			let title: string | undefined;

			if (article?.content) {
				content = htmlToMarkdown(article.content);
				title = article.title ?? undefined;
			} else {
				// Fallback: extract main content area
				const fallbackDoc = new JSDOM(outerHTML, { url: finalUrl });
				const body = fallbackDoc.window.document;
				body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());
				const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
				const fallbackHtml = (main as any)?.innerHTML || "";
				if (fallbackHtml.trim().length > 100) {
					content = htmlToMarkdown(fallbackHtml);
				} else {
					content = "(Could not extract content)";
				}
			}

			// Truncate very long content
			if (content.length > 80000) {
				content = content.slice(0, 80000) + "\n\n[Content truncated at 80KB]";
			}

			let text = `URL: ${finalUrl}`;
			if (title) text += `\nTitle: ${title}`;
			text += `\n\n${content}`;

			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}
