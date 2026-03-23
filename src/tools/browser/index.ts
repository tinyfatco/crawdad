/**
 * Browser tools — navigate, screenshot, eval, content extract, search.
 * Requires Chrome/Chromium installed. Auto-starts on first use.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBrowserContentTool } from "./content.js";
import { createBrowserEvalTool } from "./eval.js";
import { createBrowserNavigateTool } from "./navigate.js";
import { createBrowserScreenshotTool } from "./screenshot.js";
import { createBrowserSearchTool } from "./search.js";

export function createBrowserTools(): AgentTool<any>[] {
	return [
		createBrowserNavigateTool(),
		createBrowserScreenshotTool(),
		createBrowserEvalTool(),
		createBrowserContentTool(),
		createBrowserSearchTool(),
	];
}
