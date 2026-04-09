/**
 * GPT-5 harness-level steering: planning-only retry + ack fast path.
 *
 * Ported from OpenClaw's pi-embedded-runner/run/incomplete-turn.ts.
 *
 * GPT-5 has a failure mode where it narrates what it plans to do instead of
 * actually calling tools. This module detects that pattern and provides a
 * retry instruction that nudges the model into action.
 *
 * Two mechanisms:
 *   1. Planning-only retry — after prompt() resolves, if the assistant
 *      produced text-only output that reads like a plan (no mutating tool
 *      calls), we re-prompt once with a "do it now" nudge.
 *   2. Ack execution fast path — when the user message is a short approval
 *      ("ok do it", "go ahead"), we pre-inject "skip the recap, act now"
 *      into the user message before prompting.
 */

/** Tools that have side effects we can't undo on retry */
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);

/** Matches planning/intent language */
const PLANNING_ONLY_PROMISE_RE =
	/\b(?:i(?:'ll| will)|let me|going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;

/** Matches completion/summary language — if present, this is a result, not a plan */
const PLANNING_ONLY_COMPLETION_RE =
	/\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;

/** Short approval phrases (multi-language, from OpenClaw) */
const ACK_EXECUTION_NORMALIZED_SET = new Set([
	"ok", "okay", "ok do it", "okay do it", "do it", "go ahead",
	"please do", "sounds good", "sounds good do it", "ship it",
	"fix it", "make it so", "yes do it", "yep do it",
	"mach es", "leg los", "los geht s", "weiter",
	"やって", "進めて", "そのまま進めて",
	"allez y", "vas y", "fais le", "continue",
	"hazlo", "adelante", "sigue",
	"faz isso", "vai em frente", "pode fazer",
	"해줘", "진행해", "계속해",
]);

export const PLANNING_ONLY_RETRY_INSTRUCTION =
	"The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";

export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
	"The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

export function isGpt5Model(model?: { id?: string; provider?: string }): boolean {
	if (!model) return false;
	if (!OPENAI_PROVIDER_IDS.has(model.provider ?? "")) return false;
	return /^gpt-5(?:[.-]|$)/i.test(model.id ?? "");
}

export function hasMutatingTool(toolsUsed: string[]): boolean {
	return toolsUsed.some((t) => MUTATING_TOOLS.has(t));
}

function normalizeAckPrompt(text: string): string {
	return text
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Detect if the assistant's response is a planning-only turn that should be retried.
 *
 * Returns the retry instruction string if all conditions pass, null otherwise.
 */
export function detectPlanningOnlyTurn(
	assistantText: string,
	toolsUsed: string[],
	model?: { id?: string; provider?: string },
): string | null {
	if (!isGpt5Model(model)) return null;
	if (hasMutatingTool(toolsUsed)) return null;

	const text = assistantText.trim();
	if (!text || text.length > 700) return null;
	if (text.includes("```")) return null;
	if (!PLANNING_ONLY_PROMISE_RE.test(text)) return null;
	if (PLANNING_ONLY_COMPLETION_RE.test(text)) return null;

	return PLANNING_ONLY_RETRY_INSTRUCTION;
}

/**
 * Detect if the user message is a short approval that should trigger the fast path.
 *
 * Returns the fast path instruction string, or null.
 */
export function resolveAckFastPath(
	messageText: string,
	model?: { id?: string; provider?: string },
): string | null {
	if (!isGpt5Model(model)) return null;

	const trimmed = messageText.trim();
	if (!trimmed || trimmed.length > 80 || trimmed.includes("\n") || trimmed.includes("?")) {
		return null;
	}

	if (ACK_EXECUTION_NORMALIZED_SET.has(normalizeAckPrompt(trimmed))) {
		return ACK_EXECUTION_FAST_PATH_INSTRUCTION;
	}

	return null;
}
