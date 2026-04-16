import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type, type TSchema } from "@sinclair/typebox";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as log from "../log.js";

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, object>;
		required?: string[];
		[key: string]: unknown;
	};
}

function jsonSchemaToTypebox(schema: McpToolDef["inputSchema"]): TSchema {
	const properties: Record<string, TSchema> = {};
	const required = new Set(schema.required || []);

	if (schema.properties) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			const prop = propSchema as { type?: string; description?: string };
			let field: TSchema;

			switch (prop.type) {
				case "number":
				case "integer":
					field = Type.Number({ description: prop.description });
					break;
				case "boolean":
					field = Type.Boolean({ description: prop.description });
					break;
				case "array":
					field = Type.Array(Type.Any(), { description: prop.description });
					break;
				case "object":
					field = Type.Any({ description: prop.description });
					break;
				default:
					field = Type.String({ description: prop.description });
					break;
			}

			properties[key] = required.has(key) ? field : Type.Optional(field);
		}
	}

	// Pi requires a "label" parameter on all tools
	properties.label = Type.String({ description: "Brief description of what you're doing with this tool" });

	return Type.Object(properties);
}

export function wrapMcpTool(
	alias: string,
	tool: McpToolDef,
	client: Client,
): AgentTool<any> {
	const namespacedName = `${alias}__${tool.name}`;
	const description = tool.description
		? `[${alias}] ${tool.description}`
		: `[${alias}] ${tool.name}`;

	return {
		name: namespacedName,
		label: namespacedName,
		description,
		parameters: jsonSchemaToTypebox(tool.inputSchema),
		execute: async (
			_toolCallId: string,
			params: Record<string, unknown>,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const { label: _label, ...toolArgs } = params;
			log.logInfo(`[mcp-client] ${namespacedName}: ${JSON.stringify(toolArgs).substring(0, 200)}`);

			try {
				const result = await client.callTool({ name: tool.name, arguments: toolArgs });

				const textParts: string[] = [];
				if ("content" in result && Array.isArray(result.content)) {
					for (const part of result.content) {
						if (part.type === "text" && "text" in part) {
							textParts.push(part.text as string);
						}
					}
				}

				const text = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result);
				const isError = "isError" in result && result.isError === true;

				if (isError) {
					log.logWarning(`[mcp-client] ${namespacedName} returned error`, text.substring(0, 200));
				}

				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[mcp-client] ${namespacedName} failed`, errMsg);
				return {
					content: [{ type: "text", text: `MCP call failed: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
