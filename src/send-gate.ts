/**
 * send-gate — suppress send_message_to_channel deliveries when a user
 * message arrived on the destination channel while the agent was drafting.
 *
 * Flow:
 *   1. Steer arrives → main.ts handleSteer calls markSteer(channel).
 *   2. LLM starts streaming a send_message_to_channel tool call →
 *      agent.ts message_update handler calls markGenStart(toolCallId).
 *   3. Tool execute() calls shouldSuppress(toolCallId, destChannel) before posting.
 *      If a steer on destChannel landed after genStart, suppress the send and
 *      return the draft back to the agent so it can reconsider.
 */

const lastSteerAt = new Map<string, number>();
const genStartAt = new Map<string, number>();

export function markSteer(channel: string): void {
	lastSteerAt.set(channel, Date.now());
}

export function markGenStart(toolCallId: string): void {
	genStartAt.set(toolCallId, Date.now());
}

export function shouldSuppress(toolCallId: string, destChannel: string): boolean {
	const startedAt = genStartAt.get(toolCallId);
	if (startedAt === undefined) return false;
	const steerAt = lastSteerAt.get(destChannel);
	if (steerAt === undefined) return false;
	return steerAt >= startedAt;
}

export function clearGen(toolCallId: string): void {
	genStartAt.delete(toolCallId);
}
