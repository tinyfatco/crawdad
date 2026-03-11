/**
 * Model resolution and runtime switching.
 *
 * Priority: env vars > settings.json > defaults.
 *
 * Models are resolved through ModelRegistry so custom providers from
 * /data/models.json (e.g. Fireworks proxy models) are available to /model
 * and runtime resolution.
 */

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

/**
 * Friendly aliases for Fireworks-backed models.
 * Includes legacy aliases for backwards compatibility.
 */
const FIREWORKS_ALIAS_TO_MODEL_ID: Record<string, string> = {
	minimax: "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p1": "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p5": "accounts/fireworks/models/minimax-m2p5",
	deepseek: "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-v3": "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-v3p1": "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-r1": "accounts/fireworks/models/deepseek-v3p1",
	kimi: "accounts/fireworks/models/kimi-k2p5",
	"kimi-k2p5": "accounts/fireworks/models/kimi-k2p5",
};

/**
 * Fireworks model definitions. US-hosted inference for models that
 * would otherwise route through China (MiniMax) or other regions.
 */
const FIREWORKS_MODELS = [
	{
		id: "accounts/fireworks/models/minimax-m2p5",
		name: "MiniMax M2.5 (Fireworks)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "accounts/fireworks/models/deepseek-v3p1",
		name: "DeepSeek V3.1 (Fireworks)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 131072,
	},
	{
		id: "accounts/fireworks/models/kimi-k2p5",
		name: "Kimi K2.5 (Fireworks)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
	},
];

/**
 * Register the Fireworks provider on a ModelRegistry.
 * Only registers if FIREWORKS_API_KEY is set in the environment.
 */
export function registerFireworksProvider(registry: ModelRegistry): void {
	if (!process.env.FIREWORKS_API_KEY) {
		return;
	}

	registry.registerProvider("fireworks", {
		baseUrl: "https://api.fireworks.ai/inference/v1",
		apiKey: "FIREWORKS_API_KEY",
		api: "openai-completions" as Api,
		models: FIREWORKS_MODELS,
	});

	log.logInfo(`Registered fireworks provider (${FIREWORKS_MODELS.length} models)`);
}

function createWorkspaceModelRegistry(workingDir?: string): ModelRegistry {
	const authStorage = AuthStorage.create();
	const modelsJsonPath = workingDir ? join(workingDir, "models.json") : undefined;
	return new ModelRegistry(authStorage, modelsJsonPath);
}

function getRegistryModels(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api>[] {
	if (modelRegistry) {
		modelRegistry.refresh();
		return modelRegistry.getAll();
	}
	return createWorkspaceModelRegistry(workingDir).getAll();
}

function findExactModel(models: Model<Api>[], provider: string, modelId: string): Model<Api> | undefined {
	const normalizedProvider = provider.toLowerCase().trim();
	const normalizedModelId = modelId.toLowerCase().trim();
	return models.find(
		(model) =>
			model.provider.toLowerCase() === normalizedProvider &&
			model.id.toLowerCase() === normalizedModelId,
	);
}

function resolveFireworksAliasModel(
	models: Model<Api>[],
	alias: string,
	providerHint?: string,
): Model<Api> | undefined {
	const normalizedAlias = alias.toLowerCase().trim();
	const modelId = FIREWORKS_ALIAS_TO_MODEL_ID[normalizedAlias];
	if (!modelId) return undefined;
	if (providerHint && providerHint.toLowerCase().trim() !== "fireworks") return undefined;
	return findExactModel(models, "fireworks", modelId);
}

/**
 * Resolve the model from env vars or settings.json, falling back to defaults.
 *
 * Priority:
 * 1. MOM_MODEL_PROVIDER + MOM_MODEL_ID env vars (set by platform)
 * 2. settings.json defaultProvider + defaultModel (set by /model command or agent)
 * 3. anthropic / claude-sonnet-4-5
 */
export function resolveModel(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api> {
	// 1. Env vars (highest priority — set by platform/crawdad-cf)
	let provider = process.env.MOM_MODEL_PROVIDER;
	let modelId = process.env.MOM_MODEL_ID;

	// 2. settings.json (set by /model command or agent bash)
	if ((!provider || !modelId) && workingDir) {
		const settings = readSettings(workingDir);
		if (!provider && settings.defaultProvider) provider = settings.defaultProvider;
		if (!modelId && settings.defaultModel) modelId = settings.defaultModel;
	}

	// 3. Defaults
	provider = provider || DEFAULT_PROVIDER;
	modelId = modelId || DEFAULT_MODEL_ID;

	const models = getRegistryModels(workingDir, modelRegistry);

	let model = findExactModel(models, provider, modelId);
	if (!model) {
		model = resolveFireworksAliasModel(models, modelId, provider);
	}

	if (!model) {
		log.logWarning(
			`Model not found: ${provider}/${modelId}`,
			`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
		);

		const fallback =
			findExactModel(models, DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ||
			getModel(DEFAULT_PROVIDER as any, DEFAULT_MODEL_ID as any);
		if (!fallback) {
			throw new Error(`Default model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} not found`);
		}
		return applyBaseUrlOverride(fallback, fallback.provider);
	}

	log.logInfo(`Model: ${model.provider}/${model.id} (api: ${model.api})`);
	return applyBaseUrlOverride(model, model.provider);
}

/**
 * Find a model by fuzzy matching against provider/id.
 * Accepts formats like "gpt-5.1", "anthropic/claude-sonnet-4-5", "minimax", etc.
 */
export function findModel(
	query: string,
	workingDir?: string,
	modelRegistry?: ModelRegistry,
): Model<Api> | undefined {
	const q = query.toLowerCase().trim();
	if (!q) return undefined;

	const allModels = getRegistryModels(workingDir, modelRegistry);

	// Friendly aliases first (e.g. /model minimax)
	const alias = resolveFireworksAliasModel(allModels, q);
	if (alias) return alias;

	// Provider/model queries (supports nested IDs like openrouter/minimax/minimax-m2.1)
	if (q.includes("/")) {
		const [provider, ...rest] = q.split("/");
		const modelQuery = rest.join("/").trim();
		if (provider && modelQuery) {
			const exact = findExactModel(allModels, provider, modelQuery);
			if (exact) return exact;

			const providerAlias = resolveFireworksAliasModel(allModels, modelQuery, provider);
			if (providerAlias) return providerAlias;

			const providerIdMatches = allModels.filter(
				(m) =>
					m.provider.toLowerCase() === provider && m.id.toLowerCase().includes(modelQuery),
			);
			if (providerIdMatches.length === 1) return providerIdMatches[0];

			const providerNameMatches = allModels.filter(
				(m) =>
					m.provider.toLowerCase() === provider && m.name.toLowerCase().includes(modelQuery),
			);
			if (providerNameMatches.length === 1) return providerNameMatches[0];
		}
	}

	// Exact id match across all providers
	const exact = allModels.find((m) => m.id.toLowerCase() === q);
	if (exact) return exact;

	// Unique substring match on id
	const idMatches = allModels.filter((m) => m.id.toLowerCase().includes(q));
	if (idMatches.length === 1) return idMatches[0];

	// Unique substring match on name
	const nameMatches = allModels.filter((m) => m.name.toLowerCase().includes(q));
	if (nameMatches.length === 1) return nameMatches[0];

	return undefined;
}

/**
 * List available models (for /model command with no args).
 */
export function listModels(
	workingDir?: string,
	modelRegistry?: ModelRegistry,
): Array<{ provider: string; id: string; name: string; api: string }> {
	return getRegistryModels(workingDir, modelRegistry).map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
	}));
}

function readSettings(workingDir: string): { defaultProvider?: string; defaultModel?: string } {
	const settingsPath = join(workingDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Apply provider-specific base URL overrides from env vars.
 * This lets the platform route traffic through a metering proxy.
 */
function applyBaseUrlOverride(model: Model<Api>, provider: string): Model<Api> {
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
