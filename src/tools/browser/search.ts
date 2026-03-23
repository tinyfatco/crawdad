/**
 * browser_search — Google search and return results.
 * Optionally fetches readable content for each result.
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
	query: Type.String({ description: "Search query" }),
	num_results: Type.Optional(Type.Number({ description: "Number of results to return (default: 5, max: 20)" })),
	fetch_content: Type.Optional(Type.Boolean({ description: "Fetch readable content from each result page (slower, default: false)" })),
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

interface SearchResult {
	title: string;
	link: string;
	snippet: string;
	content?: string;
}

export function createBrowserSearchTool(): AgentTool<typeof schema> {
	return {
		name: "browser_search",
		label: "browser",
		description:
			"Search Google and return results with titles, links, and snippets. Optionally fetch readable content from each result page. Use this for web research.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			{ query, num_results, fetch_content }: { query: string; num_results?: number; fetch_content?: boolean },
		) => {
			const maxResults = Math.min(num_results ?? 5, 20);
			const page = await getActivePage();

			const results: SearchResult[] = [];
			let start = 0;

			while (results.length < maxResults) {
				const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}`;
				await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
				await page.waitForSelector("div.MjjYud", { timeout: 5000 }).catch(() => {});

				const pageResults: SearchResult[] = await page.evaluate(() => {
					const items: { title: string; link: string; snippet: string }[] = [];
					const searchResults = document.querySelectorAll("div.MjjYud");
					for (const result of searchResults) {
						const titleEl = result.querySelector("h3");
						const linkEl = result.querySelector("a");
						const snippetEl = result.querySelector("div.VwiC3b, div[data-sncf]");
						if (titleEl && linkEl && (linkEl as HTMLAnchorElement).href && !(linkEl as HTMLAnchorElement).href.startsWith("https://www.google.com")) {
							items.push({
								title: titleEl.textContent?.trim() || "",
								link: (linkEl as HTMLAnchorElement).href,
								snippet: snippetEl?.textContent?.trim() || "",
							});
						}
					}
					return items;
				});

				if (pageResults.length === 0) break;

				for (const r of pageResults) {
					if (results.length >= maxResults) break;
					if (!results.some((e) => e.link === r.link)) {
						results.push(r);
					}
				}

				start += 10;
				if (start >= 100) break;
			}

			if (results.length === 0) {
				return { content: [{ type: "text" as const, text: "No search results found." }], details: undefined };
			}

			// Optionally fetch content
			if (fetch_content) {
				for (const result of results) {
					try {
						await Promise.race([
							page.goto(result.link, { waitUntil: "networkidle2", timeout: 15000 }),
							new Promise((r) => setTimeout(r, 10000)),
						]).catch(() => {});

						const client = await page.createCDPSession();
						const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
						const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId: root.nodeId });
						await client.detach();

						const url = page.url();
						const doc = new JSDOM(outerHTML, { url });
						const reader = new Readability(doc.window.document);
						const article = reader.parse();

						if (article?.content) {
							result.content = htmlToMarkdown(article.content).substring(0, 5000);
						} else {
							const fallbackDoc = new JSDOM(outerHTML, { url });
							const body = fallbackDoc.window.document;
							body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());
							const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
							const text = (main as any)?.innerHTML || "";
							if (text.trim().length > 100) {
								result.content = htmlToMarkdown(text).substring(0, 5000);
							}
						}
					} catch (e: unknown) {
						result.content = `(Error: ${e instanceof Error ? e.message : String(e)})`;
					}
				}
			}

			// Format output
			const lines: string[] = [];
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				lines.push(`--- Result ${i + 1} ---`);
				lines.push(`Title: ${r.title}`);
				lines.push(`Link: ${r.link}`);
				lines.push(`Snippet: ${r.snippet}`);
				if (r.content) {
					lines.push(`Content:\n${r.content}`);
				}
				lines.push("");
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	};
}
