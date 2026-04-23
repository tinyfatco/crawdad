/**
 * Slash command handler for troublemaker.
 *
 * Intercepts /model (and future commands) at the handler level
 * before the message reaches the agent loop.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { PlatformAdapter } from "./adapters/types.js";
import type { AgentRunner } from "./agent.js";
import { MomSettingsManager } from "./context.js";
import { findModel, listModels, resolveModel } from "./model-config.js";
import * as log from "./log.js";
import { formatUsageSummary, formatTokens } from "./log.js";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

/**
 * Pending input — when a command needs the user's next message (e.g. /login),
 * it registers a resolver here. handleEvent checks this before processing.
 */
const pendingInput = new Map<string, (text: string) => void>();

/**
 * Check if a channel has a pending input request.
 * If so, resolve it with the given text and return true.
 */
export function resolvePendingInput(channelId: string, text: string): boolean {
	const resolver = pendingInput.get(channelId);
	if (resolver) {
		pendingInput.delete(channelId);
		resolver(text);
		return true;
	}
	return false;
}

/**
 * Wait for the user's next message on a channel.
 * Returns a promise that resolves with the message text.
 */
function waitForInput(channelId: string): Promise<string> {
	return new Promise((resolve) => {
		pendingInput.set(channelId, resolve);
	});
}

/** Write a system action to context.jsonl so it shows in the awareness stream. */
function logSystemAction(workingDir: string, channelLabel: string, text: string): void {
	const contextFile = join(workingDir, "awareness", "context.jsonl");
	const entry = {
		type: "message",
		id: randomUUID().substring(0, 8),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text: `[${new Date().toISOString()}] [${channelLabel}] [system]: ${text}` }],
		},
	};
	try {
		appendFileSync(contextFile, JSON.stringify(entry) + "\n");
	} catch {
		// awareness dir may not exist yet on first boot
	}
}

/**
 * Handle a slash command. Returns true if the command was handled.
 */
export async function handleSlashCommand(
	text: string,
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<boolean> {
	const parts = text.trim().split(/\s+/);
	const cmd = parts[0].toLowerCase();

	switch (cmd) {
		case "/model":
			await handleModelCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		case "/verbose":
			await handleVerboseCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		case "/context":
			await handleContextCommand(channelId, platform, runner);
			return true;
		case "/compact":
			await handleCompactCommand(parts.slice(1), channelId, workingDir, platform, runner);
			return true;
		case "/clear":
			await handleClearCommand(channelId, platform, runner);
			return true;
		case "/login":
			await handleLoginCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		default:
			return false;
	}
}

async function handleModelCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	// /model (no args) — show current model
	if (args.length === 0) {
		const model = resolveModel(workingDir);
		const models = listModels(workingDir);

		// Group by provider
		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			const list = byProvider.get(m.provider) || [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		let response = `*Current model:* ${model.provider}/${model.id}\n\n`;
		response += `Use \`/model <name>\` to switch. Examples:\n`;
		response += `\`/model claude-sonnet-4-6\`\n`;
		response += `\`/model gptfive\`\n`;
		response += `\`/model anthropic/claude-opus-4-6\`\n`;

		await platform.postMessage(channelId, response);
		return;
	}

	// /model list — show all available models
	if (args[0] === "list") {
		const models = listModels(workingDir);
		const currentModel = resolveModel(workingDir);

		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			const list = byProvider.get(m.provider) || [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		let response = `*Available models:*\n`;
		for (const [provider, providerModels] of byProvider) {
			response += `\n*${provider}:*\n`;
			for (const m of providerModels.slice(0, 10)) {
				const current = m.provider === currentModel.provider && m.id === currentModel.id ? " ← current" : "";
				response += `  ${m.id}${current}\n`;
			}
			if (providerModels.length > 10) {
				response += `  _(${providerModels.length - 10} more)_\n`;
			}
		}

		await platform.postMessage(channelId, response);
		return;
	}

	// /model <query> — switch model
	const query = args.join(" ");
	const match = findModel(query, workingDir);

	if (!match) {
		await platform.postMessage(
			channelId,
			`Model not found: "${query}"\n\nUse \`/model list\` to see available models.`,
		);
		return;
	}

	// Write to settings.json
	const settingsPath = join(workingDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			// Start fresh
		}
	}

	settings.defaultProvider = match.provider;
	settings.defaultModel = match.id;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

	log.logInfo(`Model switched to ${match.provider}/${match.id} via /model command`);
	logSystemAction(workingDir, "system", `/model → ${match.provider}/${match.id}`);
	await platform.postMessage(
		channelId,
		`Switched to *${match.provider}/${match.id}*\n_(takes effect on next message)_`,
	);
}

async function handleVerboseCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	const mgr = new MomSettingsManager(workingDir);
	const platformName = platform.name;
	const arg0 = args[0]?.toLowerCase();
	const arg1 = args[1]?.toLowerCase();

	// /verbose global on|off|messages-only — set the global default
	if (arg0 === "global") {
		if (arg1 === "on" || arg1 === "true") {
			mgr.setVerboseDefault(true);
		} else if (arg1 === "off" || arg1 === "false") {
			mgr.setVerboseDefault(false);
		} else if (arg1 === "messages-only") {
			mgr.setVerboseDefault("messages-only");
		} else {
			await platform.postMessage(channelId, `Usage: \`/verbose global on|off|messages-only\``);
			return;
		}
		const label = String(mgr.getVerboseDefault());
		log.logInfo(`Verbose global default ${label} via /verbose command`);
		await platform.postMessage(channelId, `Global verbose default *${label}*`);
		return;
	}

	// /verbose clear — remove channel override
	if (arg0 === "clear") {
		mgr.setChannelVerbose(channelId, platformName, null);
		const effective = mgr.getVerbose(channelId, platformName);
		log.logInfo(`Verbose override cleared for ${platformName}/${channelId}`);
		await platform.postMessage(
			channelId,
			`Verbose override cleared for this channel\n_(using global default: ${effective ? "on" : "off"})_`,
		);
		return;
	}

	// /verbose on|off|messages-only — set channel override
	// /verbose (no args) — cycle: on → off → messages-only → on
	let value: boolean | "messages-only";
	if (!arg0) {
		const current = mgr.getVerbose(channelId, platformName);
		value = current === true ? false : current === false ? "messages-only" : true;
	} else if (arg0 === "on" || arg0 === "true") {
		value = true;
	} else if (arg0 === "off" || arg0 === "false") {
		value = false;
	} else if (arg0 === "messages-only") {
		value = "messages-only";
	} else {
		await platform.postMessage(
			channelId,
			`Usage: \`/verbose\` (cycle), \`/verbose on|off|messages-only\`, \`/verbose global on|off|messages-only\`, \`/verbose clear\``,
		);
		return;
	}

	mgr.setChannelVerbose(channelId, platformName, value);
	const globalDefault = mgr.getVerboseDefault();
	log.logInfo(`Verbose ${value} for ${platformName}/${channelId}`);
	await platform.postMessage(
		channelId,
		`Verbose *${value}* for this channel\n_(global default: ${globalDefault})_`,
	);
}

async function handleContextCommand(
	channelId: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	const info = runner.getContextInfo();

	const lines = [
		`*Context*`,
		`Model: ${info.provider}/${info.model}`,
		`Window: ${formatTokens(info.contextTokens)} / ${formatTokens(info.contextWindow)} (${info.contextPercent.toFixed(1)}%)`,
		`Messages: ${info.messageCount}`,
	];

	if (info.usage) {
		lines.push("");
		lines.push(formatUsageSummary(info.usage, info.contextTokens, info.contextWindow));
	}

	await platform.postMessage(channelId, lines.join("\n"));
}

async function handleCompactCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	await platform.postMessage(channelId, "_Compacting context..._");

	try {
		const instructions = args.length > 0 ? args.join(" ") : undefined;
		const result = await runner.compact(instructions);

		logSystemAction(workingDir, "system", `/compact ${result.messagesBefore} → ${result.messagesAfter} messages (${formatTokens(result.tokensBefore)} tokens summarized)`);
		await platform.postMessage(
			channelId,
			`_Compacted: ${result.messagesBefore} → ${result.messagesAfter} messages (${formatTokens(result.tokensBefore)} tokens summarized)_`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await platform.postMessage(channelId, `_Compact failed: ${msg}_`);
	}
}

async function handleClearCommand(
	channelId: string,
	platform: PlatformAdapter,
	runner?: AgentRunner,
): Promise<void> {
	if (!runner) {
		await platform.postMessage(channelId, "_No runner available_");
		return;
	}

	try {
		const result = await runner.clear();
		await platform.postMessage(
			channelId,
			`_Context cleared (${result.messagesCleared} messages archived)_`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await platform.postMessage(channelId, `_Clear failed: ${msg}_`);
	}
}

async function handleLoginCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	const authStorage = AuthStorage.create();
	const providers = authStorage.getOAuthProviders();

	if (args.length === 0) {
		// List available providers and their auth status
		let response = "*Available login providers:*\n\n";
		for (const p of providers) {
			const hasAuth = authStorage.hasAuth(p.id);
			const status = hasAuth ? "✓ logged in" : "✗ not logged in";
			response += `  \`${p.id}\` — ${p.name} (${status})\n`;
		}
		response += `\nUse \`/login <provider>\` to log in. Example: \`/login openai-codex\``;
		await platform.postMessage(channelId, response);
		return;
	}

	const providerId = args[0].toLowerCase();
	const provider = providers.find((p) => p.id === providerId);

	if (!provider) {
		const available = providers.map((p) => `\`${p.id}\``).join(", ");
		await platform.postMessage(
			channelId,
			`Unknown provider: "${providerId}"\n\nAvailable: ${available}`,
		);
		return;
	}

	await platform.postMessage(channelId, `_Starting ${provider.name} login..._`);

	// Fire-and-forget: the login flow waits for user input via waitForInput(),
	// which is resolved by adapter-level resolvePendingInput(). If we awaited
	// this here, we'd block the adapter's work queue and deadlock — subsequent
	// messages (including the pasted URL) would never reach the resolver.
	const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
	(async () => {
		try {
			const loginPromise = authStorage.login(providerId, {
				onAuth: async (info) => {
					let msg = `*Open this URL in your browser:*\n\n${info.url}\n\n`;
					if (info.instructions) {
						msg += `${info.instructions}\n\n`;
					}
					msg += `After authorizing, your browser will redirect to a \`localhost\` URL that won't load — that's expected. Copy the *full URL* from your browser's address bar and paste it here.`;
					await platform.postMessage(channelId, msg);
				},
				onPrompt: async (prompt) => {
					await platform.postMessage(channelId, prompt.message);
					const input = await waitForInput(channelId);
					return input;
				},
				onManualCodeInput: async () => {
					const input = await waitForInput(channelId);
					return input;
				},
				onProgress: async (message) => {
					await platform.postMessage(channelId, `_${message}_`);
				},
			});

			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Login timed out (5 min). Try /login again.")), LOGIN_TIMEOUT_MS),
			);

			await Promise.race([loginPromise, timeoutPromise]);

			// Login succeeded — auth.json is written by AuthStorage.
			// Now persist to platform secrets so it survives container restart.
			// Maps provider IDs to platform secret keys (must match crawdad-cf hydrate.ts FILE_RULES).
			const secretKeyMap: Record<string, string> = {
				"openai-codex": "codex_credentials",
			};
			const secretKey = secretKeyMap[providerId];
			const toolsToken = process.env.FAT_TOOLS_TOKEN;
			if (toolsToken && secretKey) {
				try {
					const authPath = join(homedir(), ".pi", "agent", "auth.json");
					const authData = JSON.parse(readFileSync(authPath, "utf-8"));
					const creds = authData[providerId];
					if (creds) {
						// Strip the "type" field — platform stores raw OAuth creds
						const { type: _, ...rawCreds } = creds;
						const resp = await fetch("https://tinyfat.com/api/agent/secrets", {
							method: "PATCH",
							headers: {
								"Authorization": `Bearer ${toolsToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ [secretKey]: JSON.stringify(rawCreds) }),
						});
						if (resp.ok) {
							log.logInfo(`[/login] Credentials for ${providerId} persisted to platform`);
						} else {
							log.logWarning(`[/login] Failed to persist credentials: ${resp.status}`);
							await platform.postMessage(
								channelId,
								`⚠ Logged in but failed to persist credentials (${resp.status}). They may be lost on container restart.`,
							);
						}
					}
				} catch (persistErr) {
					const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
					log.logWarning(`[/login] Credential persistence failed: ${msg}`);
					await platform.postMessage(
						channelId,
						`⚠ Logged in but failed to persist credentials. They may be lost on container restart.`,
					);
				}
			} else {
				log.logInfo(`[/login] No FAT_TOOLS_TOKEN — skipping platform persistence`);
			}

			logSystemAction(workingDir, "system", `/login ${providerId} — success`);
			await platform.postMessage(channelId, `✓ Logged in to *${provider.name}*`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[/login] Login failed for ${providerId}: ${msg}`);
			pendingInput.delete(channelId); // Clean up any dangling resolver
			await platform.postMessage(channelId, `_Login failed: ${msg}_`);
		}
	})();
}
