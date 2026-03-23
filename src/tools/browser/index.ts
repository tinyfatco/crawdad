/**
 * Browser tools — eval and screenshot.
 * Auto-starts Chrome on first use if not running.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBrowserEvalTool } from "./eval.js";
import { createBrowserScreenshotTool } from "./screenshot.js";

export function createBrowserTools(): AgentTool<any>[] {
	return [
		createBrowserEvalTool(),
		createBrowserScreenshotTool(),
	];
}
