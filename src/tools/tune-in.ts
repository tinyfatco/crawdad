/**
 * tune_in — the agent declares it is present, starting the tick loop.
 *
 * While tuned in, the TickAdapter fires an ambient steering prompt on the
 * configured interval. The agent chooses when to tune in — not the owner,
 * not the system. Going tuned-in is a positive act of showing up.
 *
 * See memory-bank/03-design/presence-and-ticks.md for the full design.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as log from "../log.js";
import {
	tuneIn,
	type TickDisposition,
	type TickInterval,
} from "../presence.js";

export interface TuneInDeps {
	workingDir: string;
	awarenessDir: string;
	onTuneIn: () => void;
}

export function createTuneInTool(deps: TuneInDeps): AgentTool<any> {
	const schema = Type.Object({
		reason: Type.String({
			description:
				"Why you're tuning in. Short phrase describing what you're present for. " +
				"Examples: 'watching for Brandon's reply', 'working through the cf-wedge plan', " +
				"'owner asked me to be with it and update as I go'.",
		}),
		interval: Type.Optional(
			Type.Union(
				[
					Type.Literal("1m"),
					Type.Literal("2m"),
					Type.Literal("2.5m"),
					Type.Literal("5m"),
					Type.Literal("10m"),
				],
				{
					description:
						"How often you receive an ambient tick prompt while tuned in. " +
						"Default 5m. Shorter intervals (1m, 2m) for tight live work. " +
						"Longer (10m) for loose ambient presence.",
				},
			),
		),
		disposition: Type.Optional(
			Type.Union(
				[Type.Literal("quiet"), Type.Literal("narrating")],
				{
					description:
						"'quiet' (default) = ambient presence, mostly silent, only reach out if " +
						"something actually surfaces. 'narrating' = owner asked for running updates, " +
						"the bar for messaging is lower.",
				},
			),
		),
	});

	return {
		name: "tune_in",
		label: "tune_in",
		description:
			"Become actively present. Starts a tick loop that nudges you every few minutes with " +
			"an ambient prompt so you can notice things, do quiet work, or reach out via " +
			"send_message_to_channel if something surfaces. Use this when you want to be 'around' " +
			"for a stretch of time — watching for a reply, working through something with a steady " +
			"heartbeat, or keeping an owner looped in while you work. Call tune_out when you're done. " +
			"If you don't, the system will auto-tune-out after 20 quiet ticks.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			params: unknown,
		) => {
			const args = params as { reason: string; interval?: TickInterval; disposition?: TickDisposition };
			const presence = tuneIn(deps.workingDir, deps.awarenessDir, {
				reason: args.reason,
				interval: args.interval,
				disposition: args.disposition,
			});
			try {
				deps.onTuneIn();
			} catch (err) {
				log.logWarning("tune_in callback failed", err instanceof Error ? err.message : String(err));
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Tuned in. Interval: ${presence.interval}. Disposition: ${presence.disposition}. You will now receive ambient tick prompts. Call tune_out when you're done being present.`,
					},
				],
				details: undefined,
			};
		},
	};
}
