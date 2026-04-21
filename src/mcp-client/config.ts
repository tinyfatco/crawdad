import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";

export interface McpServerConfig {
	alias: string;
	url: string;
	scopes: string[];
}

export interface ResolvedMcpServer extends McpServerConfig {
	token: string;
}

interface SettingsJson {
	mcpServers?: Array<{
		alias: string;
		url: string;
		secretKey: string;
		scopes?: string[];
	}>;
}

export function loadMcpConfigs(workspaceDir: string): ResolvedMcpServer[] {
	const settingsPath = join(workspaceDir, "settings.json");
	if (!existsSync(settingsPath)) return [];

	let settings: SettingsJson;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return [];
	}

	if (!settings.mcpServers || !Array.isArray(settings.mcpServers)) return [];

	const resolved: ResolvedMcpServer[] = [];
	for (const entry of settings.mcpServers) {
		if (!entry.alias || !entry.url || !entry.secretKey) {
			log.logWarning(`[mcp-client] Skipping malformed mcpServers entry`, JSON.stringify(entry));
			continue;
		}

		const tokenPath = join("/data/.config/mcp", `${entry.alias}.json`);
		if (!existsSync(tokenPath)) {
			log.logWarning(`[mcp-client] Token file not found for "${entry.alias}"`, tokenPath);
			continue;
		}

		let token: string;
		try {
			const data = JSON.parse(readFileSync(tokenPath, "utf-8"));
			token = data.token;
		} catch (err) {
			log.logWarning(`[mcp-client] Failed to read token for "${entry.alias}"`, String(err));
			continue;
		}

		if (!token) {
			log.logWarning(`[mcp-client] Empty token for "${entry.alias}"`);
			continue;
		}

		resolved.push({
			alias: entry.alias,
			url: entry.url,
			scopes: entry.scopes || [],
			token,
		});
	}

	return resolved;
}
