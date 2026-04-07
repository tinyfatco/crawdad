/**
 * tune_out — the agent declares it is no longer actively present.
 *
 * Stops the tick loop. Heartbeat still fires in this state (sparse continuity
 * layer). The agent remains reachable by inbound messages, which always wake
 * it regardless of presence.
 *
 * See memory-bank/03-design/presence-and-ticks.md for the full design.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as log from "../log.js";
import { tuneOut } from "../presence.js";

export interface TuneOutDeps {
	workingDir: string;
	awarenessDir: string;
	onTuneOut: () => void;
}

export function createTuneOutTool(deps: TuneOutDeps): AgentTool<any> {
	const schema = Type.Object({
		reason: Type.String({
			description:
				"Why you're tuning out. Short phrase. Examples: 'wrapping up for the night', " +
				"'finished the task', 'going quiet, nothing more to watch for'.",
		}),
	});

	return {
		name: "tune_out",
		label: "tune_out",
		description:
			"Stop being actively present. Ends the tick loop — you will no longer receive ambient " +
			"tick prompts. Heartbeat still fires sparsely for continuity, and inbound messages still " +
			"reach you normally. Use this when you're done with whatever you were present for: the " +
			"task is finished, the window you were watching has closed, or you just want to go quiet.",
		parameters: schema,
		execute: async (_toolCallId: string, args: { reason: string }) => {
			tuneOut(deps.workingDir, deps.awarenessDir, { reason: args.reason });
			try {
				deps.onTuneOut();
			} catch (err) {
				log.logWarning("tune_out callback failed", err instanceof Error ? err.message : String(err));
			}
			return {
				content: [
					{
						type: "text" as const,
						text: "Tuned out. Tick loop stopped. Heartbeat still fires sparsely; inbound messages still reach you.",
					},
				],
				details: undefined,
			};
		},
	};
}
