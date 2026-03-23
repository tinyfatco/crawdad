/**
 * browser_screenshot — take a screenshot of the current browser tab.
 * Saves to /tmp and returns the file path + image content.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
		description: "Take a screenshot of the current browser tab. Saves the image to /tmp and returns the file path. Use the attach tool to send the screenshot to the user.",
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

			// Save to disk so the agent can attach it
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const filepath = join(tmpdir(), `screenshot-${timestamp}.png`);
			writeFileSync(filepath, Buffer.from(base64, "base64"));

			return {
				content: [
					{ type: "text" as const, text: `Screenshot saved to: ${filepath}\nURL: ${url}\nTitle: ${title}\n\nUse the attach tool with this path to send it to the user.` },
					{ type: "image" as const, data: base64, mimeType: "image/png" } as ImageContent,
				] as (TextContent | ImageContent)[],
				details: undefined,
			};
		},
	};
}
