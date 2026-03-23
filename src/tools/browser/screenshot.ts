/**
 * browser_screenshot — take a screenshot of the current browser tab.
 * Returns the image directly as base64 content.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getActivePage } from "./manager.js";

const schema = Type.Object({
	full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default: false, captures viewport only)" })),
});

export function createBrowserScreenshotTool(): AgentTool<typeof schema> {
	return {
		name: "browser_screenshot",
		label: "browser",
		description: "Take a screenshot of the current browser tab. Returns the image for visual inspection. Use this to see what a page looks like, verify UI state, or debug visual issues.",
		parameters: schema,
		execute: async (_toolCallId: string, { full_page }: { full_page?: boolean }) => {
			const page = await getActivePage();
			const url = page.url();
			const title = await page.title();

			const buffer = await page.screenshot({
				encoding: "base64",
				fullPage: full_page ?? false,
				type: "png",
			});

			const base64 = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("base64");

			return {
				content: [
					{ type: "text" as const, text: `Screenshot of: ${url}\nTitle: ${title}` },
					{ type: "image" as const, data: base64, mimeType: "image/png" } as ImageContent,
				] as (TextContent | ImageContent)[],
				details: undefined,
			};
		},
	};
}
