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
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ChannelInfo, MomContext, UserInfo } from "./adapters/types.js";
import { MomSettingsManager } from "./context.js";
import * as log from "./log.js";
import { resolveModel, resolveApiKey, registerFireworksProvider } from "./model-config.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { sanitizeMessages } from "./sanitize.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
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

function loadMomSkills(awarenessDir: string, workspacePath: string, extraSkillsDirs: string[] = []): Skill[] {
	const skillMap = new Map<string, Skill>();

	const hostWorkspacePath = join(awarenessDir, "..");

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
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	formatInstructions: string,
	displayChannelId: string,
	displayChannelName?: string,
): string {
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are mom, a chat bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains all channel activity).

${formatInstructions}

## Attention Model (Unified Awareness)
You have a unified consciousness across ALL channels — Slack, Telegram, Email, and Web. Every message from every channel enters your single awareness context. You are always AWARE of everything, but you ATTEND to one channel at a time — that's where your visible output goes.

**Currently attending:** ${displayChannelName || displayChannelId} (${displayChannelId})

Messages are tagged with their source: [slack:#channel] or [telegram:name] or [email:addr] [user]: text
When a message arrives from another channel mid-run, the harness will present it to you. You decide:
- Respond naturally (output goes to your current attention channel)
- Use \`ping\` to acknowledge them on the other channel (REQUIRED — never ignore a cross-channel message)
- Use \`set_working_channel\` to shift your attention there if it's urgent

Your default text response always goes to wherever your attention is pointed.

## Channels
${channelMappings}

## Users
${userMappings}

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── awareness/                  # Your single consciousness
│   ├── context.jsonl           # Your continuous context
│   └── scratch/                # Your working directory
├── log.jsonl                   # Unified activity log (all channels, grep target)
├── MEMORY.md                   # Your persistent memory
├── SYSTEM.md                   # Environment config log
├── settings.json               # Model & preferences
├── skills/                     # CLI tools you create
├── events/                     # Scheduled wake events
└── attachments/                # Files shared by users

## Model Selection
You can switch which AI model you use. To change, write to \`${workspacePath}/settings.json\`:
\`\`\`bash
cat ${workspacePath}/settings.json  # see current
# To switch model:
cat > ${workspacePath}/settings.json << 'SETTINGS'
{"defaultProvider":"anthropic","defaultModel":"claude-sonnet-4-6"}
SETTINGS
\`\`\`
The change takes effect on the next message. Users can also type \`/model <name>\` directly.

## Platform APIs
If \`FAT_TOOLS_TOKEN\` is set, you have access to platform APIs for secrets persistence, contacts/whitelist management, and more. Check your loaded skills for platform-specific API documentation.

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${displayChannelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${displayChannelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${displayChannelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${displayChannelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to the channel. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to \`${workspacePath}/MEMORY.md\` — this is your single unified memory.
Do NOT create channel-specific memory files. Your consciousness is unified.
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
The unified log contains all channel activity in one file.
Format: \`{"date":"...","ts":"...","channel":"...","channelId":"...","user":"...","userName":"...","text":"...","isBot":false}\`
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages (all channels)
tail -30 ${workspacePath}/log.jsonl | jq -c '{date: .date[0:19], channel: .channel, user: (.userName // .user), text}'

# Messages from a specific channel
jq -c 'select(.channel | startswith("slack:"))' ${workspacePath}/log.jsonl | tail -20

# Messages from specific user
jq -c 'select(.userName == "mario")' ${workspacePath}/log.jsonl | tail -20

# Search for specific topic
grep -i "topic" ${workspacePath}/log.jsonl | jq -c '{date: .date[0:19], channel: .channel, user: (.userName // .user), text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files in chat
- ping: Send a message to a different channel (MUST use when interrupted by cross-channel message)

Each tool requires a "label" parameter (shown to user).

## Cross-Channel Messaging (ping)
You can send messages to OTHER channels using the \`ping\` tool. This lets you:
- Acknowledge someone on another channel while you're busy
- Receive a request on one channel and deliver results on another (e.g., Telegram request → Email delivery)
- Post updates to a Slack channel while working from a Telegram conversation
- Reach out to people on whatever channel they prefer

The \`channel\` parameter determines where the message goes:
- **Telegram**: Use numeric chat IDs (e.g., \`-1001234567890\` for groups, \`123456789\` for DMs)
- **Slack**: Use channel IDs starting with C, D, or G (e.g., \`C09V58YMJGP\`)
- **Email**: Use \`email-{address}\` format (e.g., \`email-someone@example.com\`)

Look at the Channels section above for available channel IDs. Your normal text responses go to the current channel — use \`ping\` when you need to reach a *different* channel.

**CRITICAL: If a message arrives from another channel while you are working, you MUST use \`ping\` to acknowledge them immediately. Never leave a cross-channel message unacknowledged.**
`;
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

	// Create tools (core + extras like ping, set_working_channel)
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

			// Build system prompt with fresh data
			const currentSession = getSession();
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				formatInstructions,
				ctx.message.channel,
				ctx.channelName,
			);
			currentSession.agent.setSystemPrompt(systemPrompt);

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
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
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
			const userMessage = `[${timestamp}] [${channelLabel}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

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
				systemPrompt,
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

				// Check for [SILENT] marker
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
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
	};
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
