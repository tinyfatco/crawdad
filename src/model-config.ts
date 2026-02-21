/**
 * Model resolution from environment variables.
 *
 * Reads MOM_MODEL_PROVIDER and MOM_MODEL_ID from env.
 * Falls back to anthropic / claude-sonnet-4-5.
 *
 * Pi's getModel() returns the full Model object with api type, baseUrl,
 * cost, context window, etc. Pi's streamSimple() then dispatches to the
 * correct stream function based on model.api (anthropic-messages,
 * openai-codex-responses, openai-responses, etc).
 */

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import * as log from "./log.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

/**
 * Resolve the model from env vars, falling back to defaults.
 * Applies ANTHROPIC_BASE_URL override if set (for proxy routing).
 */
export function resolveModel(): Model<Api> {
	const provider = process.env.MOM_MODEL_PROVIDER || DEFAULT_PROVIDER;
	const modelId = process.env.MOM_MODEL_ID || DEFAULT_MODEL_ID;

	const model = getModel(provider as any, modelId as any);
	if (!model) {
		log.logWarning(
			`Model not found: ${provider}/${modelId}`,
			`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
		);
		const fallback = getModel("anthropic", "claude-sonnet-4-5");
		if (!fallback) {
			throw new Error("Default model anthropic/claude-sonnet-4-5 not found in Pi registry");
		}
		return applyBaseUrlOverride(fallback, DEFAULT_PROVIDER);
	}

	log.logInfo(`Model: ${provider}/${modelId} (api: ${model.api})`);
	return applyBaseUrlOverride(model, provider);
}

/**
 * Apply provider-specific base URL overrides from env vars.
 * This lets the platform route traffic through a metering proxy.
 */
function applyBaseUrlOverride(model: Model<Api>, provider: string): Model<Api> {
	// Provider-specific base URL overrides
	const overrides: Record<string, string | undefined> = {
		anthropic: process.env.ANTHROPIC_BASE_URL,
		openai: process.env.OPENAI_BASE_URL,
		"openai-codex": process.env.OPENAI_CODEX_BASE_URL,
	};

	const override = overrides[provider];
	if (override) {
		return { ...model, baseUrl: override };
	}
	return model;
}

/**
 * Resolve API key for any provider via AuthStorage.
 * AuthStorage checks: runtime override → auth.json → OAuth token → env var → fallback.
 *
 * For env var resolution, Pi checks standard names:
 *   anthropic → ANTHROPIC_API_KEY
 *   openai → OPENAI_API_KEY
 *   openai-codex → OPENAI_API_KEY (shared with openai)
 *   etc.
 */
export async function resolveApiKey(authStorage: AuthStorage, provider: string): Promise<string> {
	const key = await authStorage.getApiKey(provider);
	if (!key) {
		throw new Error(
			`No API key found for provider "${provider}".\n\n` +
				`Set the appropriate API key environment variable, or configure auth.json.`,
		);
	}
	return key;
}
