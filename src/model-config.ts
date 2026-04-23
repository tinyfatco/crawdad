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
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

/**
 * Friendly aliases for Fireworks-backed models.
 * Includes legacy aliases for backwards compatibility.
 */
/**
 * Friendly aliases for Anthropic models.
 */
const ANTHROPIC_ALIAS_TO_MODEL_ID: Record<string, string> = {
	opus: "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
	"opus-4.6": "claude-opus-4-6",
	"sonnet-4.6": "claude-sonnet-4-6",
	"haiku-4.5": "claude-haiku-4-5-20251001",
};

/**
 * Friendly aliases for OpenAI models.
 */
const OPENAI_ALIAS_TO_MODEL_ID: Record<string, string> = {
	gpt5: "gpt-5.4",
	"gpt-5": "gpt-5.4",
	"gpt-5.4": "gpt-5.4",
	codex: "codex-5.3",
	"codex-5.3": "codex-5.3",
};

/**
 * Anthropic models to show in /model list (filter out the long tail of old models).
 */
const ANTHROPIC_LISTED_MODELS = new Set([
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5-20251001",
]);

const FIREWORKS_ALIAS_TO_MODEL_ID: Record<string, string> = {
	minimax: "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p1": "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p5": "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p7": "accounts/fireworks/models/minimax-m2p7",
	"minimax-2.7": "accounts/fireworks/models/minimax-m2p7",
	deepseek: "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-v3": "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-v3p1": "accounts/fireworks/models/deepseek-v3p1",
	"deepseek-r1": "accounts/fireworks/models/deepseek-v3p1",
	kimi: "accounts/fireworks/models/kimi-k2p5",
	"kimi-k2p5": "accounts/fireworks/models/kimi-k2p5",
	glm: "accounts/fireworks/models/glm-5",
	"glm-5": "accounts/fireworks/models/glm-5",
	glm5: "accounts/fireworks/models/glm-5",
	"glm-5p1": "accounts/fireworks/models/glm-5p1",
	"glm-5.1": "accounts/fireworks/models/glm-5p1",
	"glm-4p7": "accounts/fireworks/models/glm-4p7",
	glm4: "accounts/fireworks/models/glm-4p7",
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
		cost: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 196608,
		maxTokens: 24576,
	},
	{
		id: "accounts/fireworks/models/minimax-m2p7",
		name: "MiniMax M2.7 (Fireworks)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 196608,
		maxTokens: 24576,
	},
	{
		id: "accounts/fireworks/models/deepseek-v3p1",
		name: "DeepSeek V3.1 (Fireworks)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.56, output: 1.68, cacheRead: 0.28, cacheWrite: 0 },
		contextWindow: 163840,
		maxTokens: 20480,
	},
	{
		id: "accounts/fireworks/models/kimi-k2p5",
		name: "Kimi K2.5 (Fireworks)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.60, output: 3.00, cacheRead: 0.10, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "accounts/fireworks/models/glm-5",
		name: "GLM-5 (Fireworks)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 1.00, output: 3.20, cacheRead: 0.20, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 32768,
	},
	{
		id: "accounts/fireworks/models/glm-5p1",
		name: "GLM-5.1 (Fireworks)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 32768,
	},
	{
		id: "accounts/fireworks/models/glm-4p7",
		name: "GLM-4.7 (Fireworks)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.60, output: 2.20, cacheRead: 0.30, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 32768,
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
		baseUrl: process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
		apiKey: "FIREWORKS_API_KEY",
		api: "openai-completions" as Api,
		models: FIREWORKS_MODELS,
	});

	log.logInfo(`Registered fireworks provider (${FIREWORKS_MODELS.length} models)`);
}

function createWorkspaceModelRegistry(workingDir?: string): ModelRegistry {
	const authStorage = AuthStorage.create();
	const modelsJsonPath = workingDir ? join(workingDir, "models.json") : undefined;
	const registry = ModelRegistry.create(authStorage, modelsJsonPath);
	registerFireworksProvider(registry);
	return registry;
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

	// Friendly aliases first (e.g. /model minimax, /model opus, /model gpt5)
	const fwAlias = resolveFireworksAliasModel(allModels, q);
	if (fwAlias) return fwAlias;

	// Anthropic aliases
	const anthropicModelId = ANTHROPIC_ALIAS_TO_MODEL_ID[q];
	if (anthropicModelId) {
		const m = findExactModel(allModels, "anthropic", anthropicModelId);
		if (m) return m;
	}

	// OpenAI aliases — prefer openai-codex provider (subscription auth)
	const openaiModelId = OPENAI_ALIAS_TO_MODEL_ID[q];
	if (openaiModelId) {
		const m = findExactModel(allModels, "openai-codex", openaiModelId) ||
			findExactModel(allModels, "openai", openaiModelId);
		if (m) return m;
	}

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
 * List available models — only those with auth configured.
 * Without this filter, 700+ built-in models would flood the output.
 */
export function listModels(
	workingDir?: string,
	modelRegistry?: ModelRegistry,
): Array<{ provider: string; id: string; name: string; api: string }> {
	const registry = modelRegistry || createWorkspaceModelRegistry(workingDir);
	return registry.getAvailable()
		.filter((model) => {
			// For Anthropic, only show the models people actually want
			if (model.provider === "anthropic") {
				return ANTHROPIC_LISTED_MODELS.has(model.id);
			}
			return true;
		})
		.map((model) => ({
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
		fireworks: process.env.FIREWORKS_BASE_URL,
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
