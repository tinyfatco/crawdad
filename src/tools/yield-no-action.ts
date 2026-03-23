/**
 * yield_no_action — end the current run with no output.
 *
 * The agent calls this when it has evaluated the situation and decided
 * there is nothing to say or do. The run terminates cleanly, no message
 * is posted to the channel, and the working message (if any) is deleted.
 *
 * Primary use case: ambient engagement. The agent wakes up, reads the
 * channel, decides it has nothing to add, and yields.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as log from "../log.js";

/** Shared flag — set by the tool, read by agent.ts after the run. */
let yielded = false;

export function wasYielded(): boolean {
	return yielded;
}

export function resetYield(): void {
	yielded = false;
}

export function createYieldNoActionTool(): AgentTool<any> {
	const schema = Type.Object({
		reason: Type.String({
			description:
				"Brief internal note about why you're yielding (e.g., 'nothing to add', 'conversation is wrapping up', 'not my area'). " +
				"This is logged but never shown to users.",
		}),
	});

	return {
		name: "yield_no_action",
		label: "yield_no_action",
		description:
			"End this run without posting any message to the channel. ONLY use this during ambient " +
			"engagement or heartbeat reflections — when you were NOT directly addressed by a person " +
			"and you have evaluated the conversation and decided you have nothing to contribute. " +
			"NEVER call this when someone has @mentioned you, sent you a DM, or is directly talking " +
			"to you — in those cases you MUST respond, even if briefly.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			{ reason }: { reason: string },
		) => {
			log.logInfo(`[yield_no_action] ${reason}`);
			yielded = true;
			return {
				content: [{ type: "text" as const, text: "Yielding. Do not produce any further output — the run is ending silently." }],
				details: undefined,
			};
		},
	};
}
