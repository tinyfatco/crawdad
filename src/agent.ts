import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { copyFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ChannelInfo, MomContext, UserInfo } from "./adapters/types.js";
import { MomSettingsManager } from "./context.js";
import * as log from "./log.js";
import { resolveModel, resolveApiKey, registerFireworksProvider } from "./model-config.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { sanitizeMessages } from "./sanitize.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";
import { wasYielded, resetYield } from "./tools/yield-no-action.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface ContextInfo {
	model: string;
	provider: string;
	contextWindow: number;
	messageCount: number;
	contextTokens: number;
	contextPercent: number;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

export interface CompactResult {
	messagesBefore: number;
	messagesAfter: number;
	tokensBefore: number;
}

export interface AgentRunner {
	run(
		ctx: MomContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	/** Steer a message into the active run (mid-run injection via pi-agent) */
	steer(text: string): void;
	/** Get current context diagnostics */
	getContextInfo(): ContextInfo;
	/** Compact context — summarize old messages, keep recent */
	compact(instructions?: string): Promise<CompactResult>;
	/** Clear context entirely — archive and start fresh */
	clear(): Promise<{ messagesCleared: number }>;
}


const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(workspaceDir: string): string {
	const memoryPath = join(workspaceDir, "MEMORY.md");
	if (existsSync(memoryPath)) {
		try {
			const content = readFileSync(memoryPath, "utf-8").trim();
			if (content) {
				return content;
			}
		} catch (error) {
			log.logWarning("Failed to read memory", `${memoryPath}: ${error}`);
		}
	}
	return "(no working memory yet)";
}

// Skills cache — skills rarely change, no need to re-scan R2/FUSE on every message
const skillsCache = new Map<string, { skills: Skill[]; workspaceMtime: number }>();

function getWorkspaceSkillsMtime(dir: string): number {
	try {
		return statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function loadMomSkills(awarenessDir: string, workspacePath: string, extraSkillsDirs: string[] = []): Skill[] {
	const hostWorkspacePath = join(awarenessDir, "..");
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");

	// Check cache — invalidate only if workspace skills dir mtime changed
	const cached = skillsCache.get(awarenessDir);
	if (cached) {
		const currentMtime = getWorkspaceSkillsMtime(workspaceSkillsDir);
		if (currentMtime === cached.workspaceMtime) {
			return cached.skills;
		}
		log.logInfo(`[skills] Workspace skills changed, reloading`);
	}

	const skillMap = new Map<string, Skill>();

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load extra skills dirs first (lowest priority — e.g. platform skills via --skills)
	for (const dir of extraSkillsDirs) {
		for (const skill of loadSkillsFromDir({ dir, source: "system" }).skills) {
			skillMap.set(skill.name, skill);
		}
	}

	// Load workspace-level skills (global) — overrides system skills on collision
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	const skills = Array.from(skillMap.values());
	skillsCache.set(awarenessDir, { skills, workspaceMtime: getWorkspaceSkillsMtime(workspaceSkillsDir) });
	return skills;
}

/**
 * Build the static system prompt. This must be byte-identical across turns
 * so that Anthropic's prompt caching can cache-hit on the system prefix.
 * All dynamic state (memory, channels, users, skills, current channel)
 * goes in buildSessionPreamble() instead.
 */
function buildSystemPrompt(
	workspacePath: string,
	sandboxConfig: SandboxConfig,
	formatInstructions: string,
): string {
	const isDocker = sandboxConfig.type === "docker";
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const envDescription = isDocker
		? `Docker container (Alpine Linux). Working directory: /. Install tools with apk add.`
		: `Host machine. Working directory: ${process.cwd()}. Be careful with system modifications.`;

	return `You are mom, a chat bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- For older history beyond your context, search log.jsonl with jq/grep.
- Each message includes a <session_context> block with current channels, users, skills, memory, and which channel you're attending. Always use the latest one.

${formatInstructions}

## Attention Model
You have unified awareness across all channels (Slack, Telegram, Email, Web, Heartbeat). You ATTEND to one channel at a time — your text output goes there. Messages are tagged with source: [slack:#channel] or [telegram:name] or [email:addr] or [heartbeat:heartbeat] [user]: text

The \`heartbeat\` channel is your internal reflection space. You wake periodically for spontaneous check-ins. When attending heartbeat, review context, notice patterns, and decide whether to act. Use \`move_to_channel\` to shift to a real channel (email, Telegram, Slack) if you want to reach out or complete unfinished work.

When a cross-channel message arrives mid-run:
- Use \`send_message_to_channel\` to acknowledge on the other channel (REQUIRED — never ignore)
- Use \`move_to_channel\` to shift attention if urgent

## Environment
${envDescription}

## Workspace
${workspacePath}/
├── awareness/context.jsonl    # Conversation context
├── awareness/scratch/         # Working directory
├── log.jsonl                  # Unified activity log (JSONL: date, channel, channelId, user, userName, text, isBot)
├── MEMORY.md                  # Persistent memory (unified, not per-channel)
├── SYSTEM.md                  # Environment config log (packages, env vars, config changes)
├── settings.json              # Model & preferences (change model here or /model <name>)
├── skills/                    # Custom CLI tools (each has SKILL.md with name/description frontmatter)
├── events/                    # Scheduled wake events (JSON files)
└── attachments/               # Files shared by users

## Events
JSON files in \`${workspacePath}/events/\`. Three types:
- \`{"type": "immediate", "text": "..."}\` — triggers immediately, auto-deletes
- \`{"type": "one-shot", "text": "...", "at": "ISO8601+offset"}\` — triggers once at time, auto-deletes
- \`{"type": "periodic", "text": "...", "schedule": "cron", "timezone": "${tz}"}\` — recurring, persists until deleted

Do NOT specify \`channelId\` — events run in the heartbeat channel by default. If the task needs to reach a specific channel (email, Telegram, Slack), use \`move_to_channel\` during execution.

Use unique filenames (include timestamp suffix). Max 5 queued events.
Triggered events appear as: \`[EVENT:filename.json:type:time] text\`
For periodic events with nothing to report, respond with just \`[SILENT]\`.
Debounce immediate events — batch multiple signals into one rather than creating many.
Timezone: ${tz}. Assume this when users don't specify.

## Tools
bash, read, write, edit, attach, ping (cross-channel messaging). Each requires a "label" parameter.
Use \`ping\` with channel ID to message a different channel. Channel ID formats: Telegram=numeric, Slack=C/D/G prefix, Email=email-{address}.
`;
}

/**
 * Build the dynamic session preamble injected into each user message.
 * Contains state that changes between turns: channels, users, skills, memory, attention.
 */
function buildSessionPreamble(
	memory: string,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	displayChannelId: string,
	displayChannelName?: string,
): string {
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(none)";
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(none)";
	const skillsSection = skills.length > 0 ? formatSkillsForPrompt(skills) : "(none)";
	const attending = displayChannelName ? `${displayChannelName} (${displayChannelId})` : displayChannelId;

	return `<session_context>
Attending: ${attending}
Channels:
${channelMappings}
Users:
${userMappings}
Skills:
${skillsSection}
Memory:
${memory}
</session_context>`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per awareness dir
const runners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for the unified awareness.
 * One runner per agent process — persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	awarenessDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
): AgentRunner {
	const existing = runners.get(awarenessDir);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, awarenessDir, formatInstructions, extraSkillsDirs, extraTools);
	runners.set(awarenessDir, runner);
	return runner;
}

/**
 * Create a new AgentRunner for the unified awareness.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	awarenessDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
): AgentRunner {
	const t0 = performance.now();
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(join(awarenessDir, ".."));

	// Create tools (core + extras like send_message_to_channel, move_to_channel)
	const tools = [...createMomTools(executor), ...extraTools];

	// Minimal system prompt for agent creation — will be replaced with full prompt in run()
	const systemPrompt = "Initializing...";

	// Create session manager and settings manager
	const contextFile = join(awarenessDir, "context.jsonl");
	const workspaceDir = join(awarenessDir, "..");
	const settingsManager = new MomSettingsManager(workspaceDir);

	// Create AuthStorage and ModelRegistry
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, join(workspaceDir, "models.json"));

	// Register Fireworks provider
	registerFireworksProvider(modelRegistry);

	// Resolve model: env vars > settings.json > defaults
	const model = resolveModel(workspaceDir, modelRegistry);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async (provider: string) => resolveApiKey(authStorage, provider),
	});

	// Defer context loading to run()
	let sessionManager: SessionManager | null = null;
	const getSessionManager = () => {
		if (!sessionManager) {
			const t = performance.now();
			sessionManager = SessionManager.open(contextFile, awarenessDir);
			log.logInfo(`[perf] SessionManager.open: ${(performance.now() - t).toFixed(0)}ms`);
		}
		return sessionManager;
	};

	log.logInfo(`[perf] createRunner (no R2 reads): ${(performance.now() - t0).toFixed(0)}ms`);

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Session created lazily on first run
	let session: AgentSession | null = null;
	const getSession = () => {
		if (!session) {
			session = new AgentSession({
				agent,
				sessionManager: getSessionManager(),
				settingsManager: settingsManager as any,
				cwd: process.cwd(),
				modelRegistry,
				resourceLoader,
				baseToolsOverride,
			});
			session.subscribe(eventHandler);
		}
		return session;
	};

	// Mutable per-run state
	const runState = {
		ctx: null as MomContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		initialPromptSent: false,
		systemPromptSet: false,
	};

	// Event handler
	const eventHandler = async (event: any) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			ctx.emitContentBlock?.({ type: "toolCall", id: agentEvent.toolCallId, name: agentEvent.toolName, arguments: agentEvent.args || {} });
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgs(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			ctx.emitContentBlock?.({ type: "toolResult", toolCallId: agentEvent.toolCallId, result: resultStr, isError: agentEvent.isError || false });
			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_update") {
			const agentEvent = event as AgentEvent & { type: "message_update" };
			const ame = agentEvent.assistantMessageEvent as any;
			if (ame.type === "text_delta") {
				ctx.emitContentBlock?.({ type: "text_delta", delta: ame.delta });
			} else if (ame.type === "thinking_delta") {
				ctx.emitContentBlock?.({ type: "thinking_delta", delta: ame.delta });
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			} else if (agentEvent.message.role === "user") {
				if (runState.initialPromptSent) {
					log.logInfo(`[awareness] Steered message detected, restarting working message`);
					queue.enqueue(async () => {
						await ctx.restartWorking();
					}, "restart working for steer");
				} else {
					runState.initialPromptSent = true;
				}
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					ctx.emitContentBlock?.({ type: "thinking", thinking });
					const lines = thinking.trim().split("\n").map((l: string) => l.trim()).filter(Boolean);
					const formatted = "💭 " + lines.map((l: string) => `_${l}_`).join("\n");
					queue.enqueueMessage(formatted, "main", "thinking main");
					queue.enqueueMessage(formatted, "thread", "thinking thread", false);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					ctx.emitContentBlock?.({ type: "text", text });
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	};

	// Message length limit
	const MAX_MESSAGE_LENGTH = 40000;
	const splitMessage = (text: string): string[] => {
		if (text.length <= MAX_MESSAGE_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, MAX_MESSAGE_LENGTH - 50);
			remaining = remaining.substring(MAX_MESSAGE_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: MomContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			const tRun = performance.now();

			// Ensure awareness directory exists
			await mkdir(awarenessDir, { recursive: true });

			const tR2 = performance.now();
			const sm = getSessionManager();

			// No sync step — the runner is the sole writer to context.jsonl
			const tCtx = performance.now();
			const reloadedSession = sm.buildSessionContext();
			log.logInfo(`[perf] buildSessionContext: ${(performance.now() - tCtx).toFixed(0)}ms`);

			if (reloadedSession.messages.length > 0) {
				const tSan = performance.now();
				const sanitized = sanitizeMessages(reloadedSession.messages as unknown as Parameters<typeof sanitizeMessages>[0]);
				agent.replaceMessages(sanitized as unknown as typeof reloadedSession.messages);
				log.logInfo(`[perf] sanitize+replace (${sanitized.length} msgs): ${(performance.now() - tSan).toFixed(0)}ms`);
			}

			const tMem = performance.now();
			const memory = getMemory(join(awarenessDir, ".."));
			log.logInfo(`[perf] getMemory: ${(performance.now() - tMem).toFixed(0)}ms`);

			const tSkills = performance.now();
			const skills = loadMomSkills(awarenessDir, workspacePath, extraSkillsDirs);
			log.logInfo(`[perf] loadMomSkills (${skills.length} skills): ${(performance.now() - tSkills).toFixed(0)}ms`);

			log.logInfo(`[perf] total R2 reads: ${(performance.now() - tR2).toFixed(0)}ms`);

			// Set static system prompt (only changes if formatInstructions/sandbox change — effectively never)
			const currentSession = getSession();
			if (!runState.systemPromptSet) {
				const systemPrompt = buildSystemPrompt(workspacePath, sandboxConfig, formatInstructions);
				currentSession.agent.setSystemPrompt(systemPrompt);
				runState.systemPromptSet = true;
			}

			// Build dynamic preamble (injected into user message below)
			const sessionPreamble = buildSessionPreamble(
				memory,
				ctx.channels,
				ctx.users,
				skills,
				ctx.message.channel,
				ctx.channelName,
			);

			// Re-resolve model each run
			const currentModel = resolveModel(workspaceDir, modelRegistry);
			const agentModel = agent.state.model;
			if (agentModel && (currentModel.id !== agentModel.id || currentModel.provider !== agentModel.provider)) {
				log.logInfo(`[awareness] Model changed to ${currentModel.provider}/${currentModel.id}`);
				agent.setModel(currentModel);
			}

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, awarenessDir, workspacePath);
				await ctx.uploadFile(hostPath, title);
			});

			log.logInfo(`[perf] run() pre-prompt setup: ${(performance.now() - tRun).toFixed(0)}ms`);

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.initialPromptSent = false;
			resetYield(); // Clear any stale yield from previous run

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Platform API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitMessage(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - preamble: ${sessionPreamble.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp, channel tag, and username
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;

			// Always tag messages with source channel
			const channelLabel = ctx.channelName || ctx.message.channel;
			const userMessage = `${sessionPreamble}\n\n[${timestamp}] [${channelLabel}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			let finalUserMessage = userMessage;
			if (nonImagePaths.length > 0) {
				finalUserMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt: currentSession.agent.state.systemPrompt,
				sessionPreamble,
				messages: currentSession.messages,
				newUserMessage: finalUserMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(awarenessDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			log.logInfo(`[awareness] Pre-prompt: ${currentSession.messages.length} messages in context`);

			const tPrompt = performance.now();
			await currentSession.prompt(finalUserMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);
			log.logInfo(`[perf] session.prompt (incl API): ${(performance.now() - tPrompt).toFixed(0)}ms`);

			// If overflow error triggered background compaction+retry, wait for it.
			if (runState.stopReason === "error") {
				await agent.waitForIdle();

				const msgs = currentSession.messages;
				const last = msgs.filter((m) => m.role === "assistant").pop() as any;
				if (last && last.stopReason && last.stopReason !== "error") {
					runState.stopReason = last.stopReason;
					runState.errorMessage = undefined;
				}
			}

			// Wait for queued messages
			await queueChain;

			// Handle error case
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.sendFinalResponse("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = currentSession.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check if yield_no_action was called — skip posting final response
				if (wasYielded()) {
					log.logInfo("yield_no_action — no output posted");
					resetYield();
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > MAX_MESSAGE_LENGTH
								? `${finalText.substring(0, MAX_MESSAGE_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.sendFinalResponse(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary
			if (runState.totalUsage.cost.total > 0) {
				const messages = currentSession.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = agent.state.model?.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			log.logInfo(`[perf] TOTAL run(): ${(performance.now() - tRun).toFixed(0)}ms`);
			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			if (session) session.abort();
		},

		steer(text: string): void {
			const s = getSession();
			if (s.isStreaming) {
				s.steer(text).catch((err: Error) => {
					log.logWarning(`[awareness] steer failed`, err.message);
				});
			} else {
				log.logWarning(`[awareness] steer called but not streaming, ignoring`);
			}
		},

		getContextInfo(): ContextInfo {
			// Re-resolve model to pick up settings.json changes
			const currentModel = resolveModel(workspaceDir, modelRegistry);
			const contextWindow = currentModel?.contextWindow || 200000;

			// Ensure messages are loaded from context.jsonl
			const sm = getSessionManager();
			const currentSession = getSession();
			if (currentSession.messages.length === 0) {
				const restored = sm.buildSessionContext();
				if (restored.messages.length > 0) {
					agent.replaceMessages(restored.messages);
				}
			}
			const messages = currentSession.messages;

			// Find last assistant message with usage data
			let contextTokens = 0;
			let usage: ContextInfo["usage"] = undefined;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as any;
				if (m.role === "assistant" && m.usage) {
					contextTokens = m.usage.input + m.usage.output +
						(m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
					usage = {
						input: m.usage.input || 0,
						output: m.usage.output || 0,
						cacheRead: m.usage.cacheRead || 0,
						cacheWrite: m.usage.cacheWrite || 0,
						cost: m.usage.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					break;
				}
			}

			const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

			return {
				model: currentModel?.id || "unknown",
				provider: currentModel?.provider || "unknown",
				contextWindow,
				messageCount: messages.length,
				contextTokens,
				contextPercent,
				usage,
			};
		},

		async compact(instructions?: string): Promise<CompactResult> {
			const contextFile = join(awarenessDir, "context.jsonl");
			// Ensure messages are loaded from context.jsonl before counting
			const currentSession = getSession();
			if (currentSession.messages.length === 0) {
				const sm = getSessionManager();
				const restored = sm.buildSessionContext();
				if (restored.messages.length > 0) {
					agent.replaceMessages(restored.messages);
				}
			}
			const messagesBefore = currentSession.messages.length;

			// Don't compact if context is too small to benefit
			const info = this.getContextInfo();
			const MIN_COMPACT_TOKENS = 50000;
			if (info.contextTokens < MIN_COMPACT_TOKENS && info.contextTokens > 0) {
				throw new Error(`Context too small to compact (${log.formatTokens(info.contextTokens)} tokens, minimum ${log.formatTokens(MIN_COMPACT_TOKENS)})`);
			}

			// Archive before compacting
			await archiveContext(contextFile);

			const result = await getSession().compact(instructions);

			// session.compact() already calls agent.replaceMessages() internally
			return {
				messagesBefore,
				messagesAfter: currentSession.messages.length,
				tokensBefore: result.tokensBefore,
			};
		},

		async clear(): Promise<{ messagesCleared: number }> {
			const contextFile = join(awarenessDir, "context.jsonl");
			// Ensure messages are loaded from context.jsonl before counting
			const sm = getSessionManager();
			const currentSession = getSession();
			if (currentSession.messages.length === 0) {
				const restored = sm.buildSessionContext();
				if (restored.messages.length > 0) {
					agent.replaceMessages(restored.messages);
				}
			}
			const messagesCleared = currentSession.messages.length;

			// Archive before clearing
			await archiveContext(contextFile);

			// Truncate context.jsonl
			writeFileSync(contextFile, "", "utf-8");

			// Reset in-memory state
			agent.replaceMessages([]);
			sessionManager = null;
			session = null;

			log.logInfo(`[awareness] Context cleared (${messagesCleared} messages archived)`);
			return { messagesCleared };
		},
	};
}

/**
 * Archive context.jsonl to awareness/history/<date>/<uuid>.jsonl
 */
async function archiveContext(contextFile: string): Promise<void> {
	if (!existsSync(contextFile)) return;
	const stat = statSync(contextFile);
	if (stat.size === 0) return;

	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
	const historyDir = join(contextFile, "..", "history", dateStr);
	await mkdir(historyDir, { recursive: true });

	const archivePath = join(historyDir, `${randomUUID()}.jsonl`);
	await copyFile(contextFile, archivePath);
	log.logInfo(`[awareness] Archived context to ${archivePath}`);
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	awarenessDir: string,
	workspacePath: string,
): string {
	if (workspacePath === "/workspace") {
		if (containerPath.startsWith("/workspace/")) {
			return join(awarenessDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
