import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as log from "../log.js";
import { loadMcpConfigs, type ResolvedMcpServer } from "./config.js";
import { wrapMcpTool } from "./wrap-tool.js";

interface ConnectedServer {
	alias: string;
	client: Client;
	transport: StreamableHTTPClientTransport;
	tools: AgentTool<any>[];
}

export class McpBridge {
	private servers: ConnectedServer[] = [];
	private workspaceDir: string;
	private connected = false;

	constructor(workspaceDir: string) {
		this.workspaceDir = workspaceDir;
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		const configs = loadMcpConfigs(this.workspaceDir);
		if (configs.length === 0) {
			log.logInfo("[mcp-client] No MCP servers configured");
			this.connected = true;
			return;
		}

		log.logInfo(`[mcp-client] Connecting to ${configs.length} MCP server(s)`);

		const results = await Promise.allSettled(
			configs.map((config) => this.connectOne(config)),
		);

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const config = configs[i];
			if (result.status === "rejected") {
				log.logWarning(
					`[mcp-client] Failed to connect to "${config.alias}" (${config.url})`,
					String(result.reason),
				);
			}
		}

		this.connected = true;
		const toolCount = this.servers.reduce((sum, s) => sum + s.tools.length, 0);
		log.logInfo(`[mcp-client] Connected: ${this.servers.length} server(s), ${toolCount} tools`);
	}

	private async connectOne(config: ResolvedMcpServer): Promise<void> {
		const transport = new StreamableHTTPClientTransport(
			new URL(config.url),
			{
				requestInit: {
					headers: {
						Authorization: `Bearer ${config.token}`,
					},
				},
			},
		);

		const client = new Client(
			{ name: "tinyfat-agent", version: "1.0.0" },
			{ capabilities: {} },
		);

		await client.connect(transport);

		const toolsResult = await client.listTools();
		const tools: AgentTool<any>[] = [];

		for (const mcpTool of toolsResult.tools) {
			tools.push(wrapMcpTool(config.alias, mcpTool, client));
		}

		log.logInfo(`[mcp-client] "${config.alias}": ${tools.length} tools from ${config.url}`);

		this.servers.push({ alias: config.alias, client, transport, tools });
	}

	tools(): AgentTool<any>[] {
		return this.servers.flatMap((s) => s.tools);
	}

	serverSummary(): string[] {
		return this.servers.map(
			(s) => `${s.alias}: ${s.tools.length} tools (${s.tools.map((t) => t.name).join(", ")})`,
		);
	}

	async disconnect(): Promise<void> {
		for (const server of this.servers) {
			try {
				await server.transport.close();
			} catch {
				// best-effort
			}
		}
		this.servers = [];
		this.connected = false;
	}
}
