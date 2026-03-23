/**
 * browser_eval — execute JavaScript in the browser tab.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getActivePage } from "./manager.js";

const schema = Type.Object({
	code: Type.String({ description: "JavaScript code to evaluate in the browser context. Can be an expression or statement." }),
});

export function createBrowserEvalTool(): AgentTool<typeof schema> {
	return {
		name: "browser_eval",
		label: "browser",
		description: "Execute JavaScript code in the current browser tab and return the result. Useful for interacting with page elements, reading DOM state, clicking buttons, filling forms, etc.",
		parameters: schema,
		execute: async (_toolCallId: string, { code }: { code: string }) => {
			const page = await getActivePage();

			const result = await page.evaluate((c: string) => {
				// eslint-disable-next-line no-new-func
				const fn = new Function(`return (async () => { return (${c}); })()`) as () => Promise<unknown>;
				return fn();
			}, code);

			let text: string;
			if (Array.isArray(result)) {
				text = JSON.stringify(result, null, 2);
			} else if (typeof result === "object" && result !== null) {
				text = JSON.stringify(result, null, 2);
			} else if (result === undefined) {
				text = "undefined";
			} else {
				text = String(result);
			}

			// Truncate very long results
			if (text.length > 50000) {
				text = text.slice(0, 50000) + "\n\n[Output truncated at 50KB]";
			}

			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}
