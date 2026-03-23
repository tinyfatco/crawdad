/**
 * browser_navigate — navigate browser to a URL.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getActivePage, getBrowser } from "./manager.js";

const schema = Type.Object({
	url: Type.String({ description: "URL to navigate to" }),
	new_tab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of current tab (default: false)" })),
});

export function createBrowserNavigateTool(): AgentTool<typeof schema> {
	return {
		name: "browser_navigate",
		label: "browser",
		description: "Navigate the browser to a URL. By default navigates the current tab. Use new_tab to open in a separate tab.",
		parameters: schema,
		execute: async (_toolCallId: string, { url, new_tab }: { url: string; new_tab?: boolean }) => {
			if (new_tab) {
				const browser = await getBrowser();
				const page = await browser.newPage();
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
				const title = await page.title();
				return { content: [{ type: "text" as const, text: `Opened new tab: ${url}\nTitle: ${title}` }], details: undefined };
			}

			const page = await getActivePage();
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
			const title = await page.title();
			return { content: [{ type: "text" as const, text: `Navigated to: ${url}\nTitle: ${title}` }], details: undefined };
		},
	};
}
