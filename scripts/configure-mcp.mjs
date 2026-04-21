#!/usr/bin/env node

/**
 * Configure an MCP server for a TinyFat agent.
 *
 * This script writes the token file and settings.json entry directly to the
 * agent's R2-mounted workspace via the crawdad-cf terminal exec endpoint.
 * It avoids needing the MASTER_KEY by writing to the live container filesystem.
 *
 * For production use, the token should be stored in encrypted_secrets_v2 and
 * hydrated at container startup. This script is a bootstrap tool for testing.
 *
 * Usage:
 *   node scripts/configure-mcp.mjs \
 *     --agent <agent-id> \
 *     --alias <alias> \
 *     --url <mcp-server-url> \
 *     --token <pat-or-bearer-token> \
 *     [--scopes content:read,content:write]
 *
 * Environment:
 *   TERMINAL_SECRET - from ~/.config/fat-agents/spider-relay.env
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
function getArg(name) {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const agentId = getArg("agent");
const alias = getArg("alias");
const url = getArg("url");
const token = getArg("token");
const scopes = (getArg("scopes") || "content:read").split(",");

if (!agentId || !alias || !url || !token) {
	console.error("Usage: node scripts/configure-mcp.mjs --agent <id> --alias <alias> --url <url> --token <token>");
	process.exit(1);
}

// Read TERMINAL_SECRET from env or spider-relay.env
let terminalSecret = process.env.TERMINAL_SECRET;
if (!terminalSecret) {
	try {
		const envFile = readFileSync(`${process.env.HOME}/.config/fat-agents/spider-relay.env`, "utf-8");
		const match = envFile.match(/^TERMINAL_SECRET=(.+)$/m);
		if (match) terminalSecret = match[1];
	} catch {}
}

if (!terminalSecret) {
	console.error("TERMINAL_SECRET not found");
	process.exit(1);
}

const BASE = "https://crawdad.tinyfat.com";

async function exec(cmd) {
	const encoded = encodeURIComponent(cmd);
	const resp = await fetch(`${BASE}/agents/${agentId}/logs?token=${terminalSecret}&cmd=${encoded}`);
	if (!resp.ok) throw new Error(`exec failed: ${resp.status} ${await resp.text()}`);
	return resp.text();
}

console.log(`Configuring MCP server "${alias}" for agent ${agentId}`);
console.log(`  URL: ${url}`);
console.log(`  Scopes: ${scopes.join(", ")}`);

// 1. Write token file
console.log("\n1. Writing token file...");
const tokenJson = JSON.stringify({ token });
await exec(`mkdir -p /data/.config/mcp && printf '%s\\n' '${tokenJson.replace(/'/g, "'\\''")}' > /data/.config/mcp/${alias}.json`);
console.log(`   → /data/.config/mcp/${alias}.json`);

// 2. Update settings.json
console.log("2. Updating settings.json...");
const settingsRaw = await exec("cat /data/settings.json 2>/dev/null || echo '{}'");
let settings;
try {
	settings = JSON.parse(settingsRaw.trim());
} catch {
	settings = {};
}

if (!settings.mcpServers) settings.mcpServers = [];

// Remove existing entry for this alias
settings.mcpServers = settings.mcpServers.filter(s => s.alias !== alias);

settings.mcpServers.push({
	alias,
	url,
	secretKey: `mcp_${alias}_token`,
	scopes,
	addedAt: new Date().toISOString(),
});

const settingsJson = JSON.stringify(settings, null, 2);
await exec(`printf '%s\\n' '${settingsJson.replace(/'/g, "'\\''")}' > /data/settings.json`);
console.log(`   → settings.json updated (${settings.mcpServers.length} MCP server(s))`);

// 3. Verify
console.log("3. Verifying...");
const verify = await exec("cat /data/.config/mcp/" + alias + ".json && echo '---' && cat /data/settings.json | grep -c mcpServers");
console.log(`   → ${verify.trim()}`);

console.log("\nDone! Restart the agent for changes to take effect:");
console.log(`  curl -s -X POST "${BASE}/agents/${agentId}/restart?token=\$TERMINAL_SECRET"`);
