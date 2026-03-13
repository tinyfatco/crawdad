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
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
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

function getMemory(channelDir: string, isTrunk = false): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceDir = isTrunk ? join(channelDir, "..") : join(channelDir, "..");
	const workspaceMemoryPath = join(workspaceDir, "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// For trunk mode, skip channel-specific memory (it fragments consciousness)
	if (!isTrunk) {
		const channelMemoryPath = join(channelDir, "MEMORY.md");
		if (existsSync(channelMemoryPath)) {
			try {
				const content = readFileSync(channelMemoryPath, "utf-8").trim();
				if (content) {
					parts.push(`### Channel-Specific Memory\n${content}`);
				}
			} catch (error) {
				log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
			}
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadMomSkills(channelDir: string, workspacePath: string, extraSkillsDirs: string[] = []): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

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
			// Extra skills dirs use absolute paths (not translated — they're on the image filesystem)
			skillMap.set(skill.name, skill);
		}
	}

	// Load workspace-level skills (global) — overrides system skills on collision
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	formatInstructions: string,
	trunkInfo?: { displayChannelId: string; displayChannelName?: string },
): string {
	const isTrunk = channelId === "_slack_trunk";
	const channelPath = isTrunk ? `${workspacePath}/_slack_trunk` : `${workspacePath}/${channelId}`;
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

	// Trunk-specific context section
	const trunkContext = isTrunk && trunkInfo ? `
## Attention Model
You have a unified consciousness across all Slack channels. You are always AWARE of messages from every channel (they all enter your context), but you ATTEND to one channel at a time — that's where your visible output goes.

**Currently attending:** #${trunkInfo.displayChannelName || trunkInfo.displayChannelId} (${trunkInfo.displayChannelId})

Messages from other channels are tagged with their source: [#channel-name | CHANNEL_ID] [user]: text
When a message arrives from another channel mid-run, the harness will present it to you. You decide:
- Respond naturally (output goes to your current attention channel)
- Use \`send_message\` to acknowledge them on the other channel
- Use \`set_working_channel\` to shift your attention there

Your default text response always goes to wherever your attention is pointed.` : "";

	const workspaceLayout = isTrunk ? `## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Your memory (shared across all channels)
├── settings.json                # Model & preferences (see below)
├── skills/                      # Global CLI tools you create
├── _slack_trunk/                # Unified Slack context
│   ├── context.jsonl            # Your continuous context (all Slack channels)
│   └── scratch/                 # Your working directory
├── C.../                        # Per-channel logs (written by adapters)
│   └── log.jsonl                # Message history for that channel
└── ...other channel dirs/` : `## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── settings.json                # Model & preferences (see below)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools`;

	return `You are mom, a chat bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

${formatInstructions}
${trunkContext}

## Channels
${channelMappings}

## Users
${userMappings}

## Environment
${envDescription}

${workspaceLayout}

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
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
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
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
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
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
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
Write to MEMORY.md to persist context across conversations.${isTrunk ? `
- Write to ${workspacePath}/MEMORY.md — this is your single unified memory.
- Do NOT create channel-specific MEMORY.md files. Your consciousness is unified.` : `
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work`}
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
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files in chat
- send_message: Send a message to a different channel (cross-channel messaging)

Each tool requires a "label" parameter (shown to user).

## Cross-Channel Messaging
You can send messages to OTHER channels using the \`send_message\` tool. This lets you:
- Receive a request on one channel and deliver results on another (e.g., Telegram request → Email delivery)
- Post updates to a Slack channel while working from a Telegram conversation
- Reach out to people on whatever channel they prefer

The \`channel\` parameter determines where the message goes:
- **Telegram**: Use numeric chat IDs (e.g., \`-1001234567890\` for groups, \`123456789\` for DMs)
- **Slack**: Use channel IDs starting with C, D, or G (e.g., \`C09V58YMJGP\`)
- **Email**: Use \`email-{address}\` format (e.g., \`email-someone@example.com\`)

Look at the Channels section above for available channel IDs. Your normal text responses go to the current channel — use \`send_message\` only when you need to reach a *different* channel.
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

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel (or trunk).
 * Runners are cached - one per channel/trunk, persistent across messages.
 *
 * @param channelNameMap - For trunk mode: maps channel IDs to names for message tagging
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
	channelNameMap?: Map<string, string>,
): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir, formatInstructions, extraSkillsDirs, extraTools, channelNameMap);
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
	channelNameMap?: Map<string, string>,
): AgentRunner {
	const isTrunk = channelId === "_slack_trunk";
	const t0 = performance.now();
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));

	// Create tools (core + any extras like heartbeat's send_message)
	const tools = [...createMomTools(executor), ...extraTools];

	// Minimal system prompt for agent creation — will be replaced with full prompt in run()
	const systemPrompt = "Initializing...";

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const workspaceDir = join(channelDir, "..");
	const settingsManager = new MomSettingsManager(workspaceDir);

	// Create AuthStorage and ModelRegistry
	// Important: point ModelRegistry at workspace models.json (/data/models.json)
	// so custom providers (e.g. fireworks proxy) are available to /model and runtime.
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, join(workspaceDir, "models.json"));

	// Register Fireworks provider (US-hosted inference for MiniMax, DeepSeek, Kimi)
	registerFireworksProvider(modelRegistry);

	// Resolve model: env vars > settings.json > defaults
	const model = resolveModel(workspaceDir, modelRegistry);

	// Create agent — getApiKey is provider-generic (resolves via AuthStorage for any provider)
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

	// Defer context loading to run() — avoid double-reading from R2
	// SessionManager.open() and buildSessionContext() read context.jsonl over s3fs,
	// and run() will read it again anyway. Do it once.
	let sessionManager: SessionManager | null = null;
	const getSessionManager = () => {
		if (!sessionManager) {
			const t = performance.now();
			sessionManager = SessionManager.open(contextFile, channelDir);
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

	// Session created lazily on first run (needs sessionManager which reads R2)
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
			// Subscribe to events
			session.subscribe(eventHandler);
		}
		return session;
	};

	// Mutable per-run state - event handler references this
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
		/** Tracks whether the initial prompt has been sent — subsequent user messages are steered */
		initialPromptSent: false,
	};

	// Event handler — extracted so it can be attached when session is lazily created
	const eventHandler = async (event: any) => {
		const eventType = event.type || "unknown";
		try {
		// Log events — skip noisy message_update deltas
		if (eventType === "message_update") {
			// Only log toolcall events, not every text delta
			const subType = event.assistantMessageEvent?.type;
			if (subType && subType.startsWith("toolcall")) {
				log.logInfo(`[event] message_update:${subType}`);
			}
		} else {
			log.logInfo(`[event] ${eventType}`);
		}

		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) {
			log.logWarning(`[event] ${eventType} received but no active run state (ctx=${!!runState.ctx} logCtx=${!!runState.logCtx} queue=${!!runState.queue})`);
			return;
		}

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

			// Post args + result to thread
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

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			} else if (agentEvent.message.role === "user") {
				if (runState.initialPromptSent) {
					// A user message appeared mid-run — this is a steered message.
					// Restart the working message so the continuation gets a fresh Message 1.
					log.logInfo(`[${logCtx.channelId}] Steered message detected, restarting working message`);
					queue.enqueue(async () => {
						await ctx.restartWorking();
					}, "restart working for steer");
				} else {
					// First user message in this run — mark as sent so subsequent ones trigger steer UX
					runState.initialPromptSent = true;
				}
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			log.logInfo(`[event] message_end role=${agentEvent.message.role}`);
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				// Log detailed info about the assistant response
				const contentTypes = agentEvent.message.content.map((c: any) => c.type);
				log.logInfo(`[event] assistant message_end: stopReason=${assistantMsg.stopReason || "none"} errorMessage=${assistantMsg.errorMessage || "none"} contentTypes=[${contentTypes.join(",")}] contentParts=${agentEvent.message.content.length}`);

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
					log.logWarning(`[event] assistant error: ${assistantMsg.errorMessage}`);
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
					const lines = thinking.trim().split("\n").map((l: string) => l.trim()).filter(Boolean);
					const formatted = "💭 " + lines.map((l: string) => `_${l}_`).join("\n");
					queue.enqueueMessage(formatted, "main", "thinking main");
					queue.enqueueMessage(formatted, "thread", "thinking thread", false);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
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
		} catch (handlerErr) {
			const msg = handlerErr instanceof Error ? `${handlerErr.message}\n${handlerErr.stack}` : String(handlerErr);
			log.logWarning(`[event] HANDLER CRASHED on ${eventType}: ${msg}`);
		}
	};

	// Message length limit (adapter-specific)
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

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// --- Parallel R2 reads ---
			// These all hit s3fs (network I/O). Run concurrently instead of sequentially.
			const tR2 = performance.now();

			const sm = getSessionManager();

			// syncLogToSessionManager reads log.jsonl, buildSessionContext reads context.jsonl,
			// getMemory reads MEMORY.md, loadMomSkills scans skills dirs.
			// sync must happen before buildSessionContext, but memory/skills are independent.
			// For trunk mode, sync logs from all Slack channel directories
			const syncedCount = isTrunk
				? syncLogToSessionManager(sm, channelDir, ctx.message.ts, channelNameMap)
				: syncLogToSessionManager(sm, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}
			log.logInfo(`[perf] log sync: ${(performance.now() - tR2).toFixed(0)}ms`);

			// These three are independent — but they're sync fs calls (readFileSync via s3fs).
			// We can't truly parallelize sync calls without worker threads.
			// For now, instrument each one so we know where the time goes.
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
			const memory = getMemory(channelDir, isTrunk);
			log.logInfo(`[perf] getMemory: ${(performance.now() - tMem).toFixed(0)}ms`);

			const tSkills = performance.now();
			const skills = loadMomSkills(channelDir, workspacePath, extraSkillsDirs);
			log.logInfo(`[perf] loadMomSkills (${skills.length} skills): ${(performance.now() - tSkills).toFixed(0)}ms`);

			log.logInfo(`[perf] total R2 reads: ${(performance.now() - tR2).toFixed(0)}ms`);

			// Build system prompt with fresh data
			const currentSession = getSession();
			const trunkInfo = isTrunk ? {
				displayChannelId: ctx.message.channel,
				displayChannelName: ctx.channelName || channelNameMap?.get(ctx.message.channel),
			} : undefined;
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				formatInstructions,
				trunkInfo,
			);
			currentSession.agent.setSystemPrompt(systemPrompt);

			// Re-resolve model each run (picks up /model command changes from settings.json)
			const currentModel = resolveModel(workspaceDir, modelRegistry);
			const agentModel = agent.state.model;
			if (agentModel && (currentModel.id !== agentModel.id || currentModel.provider !== agentModel.provider)) {
				log.logInfo(`[${channelId}] Model changed to ${currentModel.provider}/${currentModel.id}`);
				agent.setModel(currentModel);
			}

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
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
					log.logInfo(`[queue] enqueued: ${errorContext}`);
					queueChain = queueChain.then(async () => {
						const tq = performance.now();
						log.logInfo(`[queue] start: ${errorContext}`);
						try {
							await fn();
							log.logInfo(`[queue] done: ${errorContext} (${(performance.now() - tq).toFixed(0)}ms)`);
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							const stack = err instanceof Error ? err.stack : undefined;
							log.logWarning(`Platform API error (${errorContext})`, `${errMsg}${stack ? `\n${stack}` : ""}`);
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

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			// For trunk mode, tag messages with source channel
			let userMessage: string;
			if (isTrunk) {
				const channelName = ctx.channelName || channelNameMap?.get(ctx.message.channel) || ctx.message.channel;
				userMessage = `[${timestamp}] [#${channelName} | ${ctx.message.channel}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;
			} else {
				userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;
			}

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

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: currentSession.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			try {
				const tWrite = performance.now();
				await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));
				log.logInfo(`[perf] writeFile last_prompt.jsonl: ${(performance.now() - tWrite).toFixed(0)}ms`);
			} catch (err) {
				log.logWarning(`[debug] Failed to write last_prompt.jsonl: ${err instanceof Error ? err.message : String(err)}`);
			}

			log.logInfo(`[run] calling session.prompt() with ${userMessage.length} char message, ${imageAttachments.length} images`);
			const tPrompt = performance.now();

			// Monkeypatch: wrap agent.emit to log events as they flow through the for-await consumer
			const origEmit = (agent as any).emit?.bind(agent);
			if (origEmit && !(agent as any).__emitPatched) {
				(agent as any).__emitPatched = true;
				(agent as any).emit = (e: any) => {
					if (e.type !== "message_update") {
						log.logInfo(`[agent.emit] ${e.type}${e.message?.stopReason ? ` stopReason=${e.message.stopReason}` : ""}`);
					}
					origEmit(e);
				};
			}

			try {
				// Race prompt against 45s timeout
				const promptPromise = currentSession.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);
				const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 45000));
				const result = await Promise.race([promptPromise.then(() => "done" as const), timeoutPromise]);

				if (result === "timeout") {
					log.logWarning(`[run] session.prompt() TIMED OUT after 45s`);
					const agentState = (agent as any)._state;
					log.logWarning(`[run] agent state: isStreaming=${agentState?.isStreaming} pendingToolCalls=${agentState?.pendingToolCalls?.size || 0} error=${agentState?.error || 'none'} msgs=${agentState?.messages?.length || 0}`);
					log.logWarning(`[run] runState: stopReason=${runState.stopReason} errorMessage=${runState.errorMessage || 'none'}`);
					// Force abort and continue
					agent.abort();
					await agent.waitForIdle();
					log.logInfo(`[run] agent aborted and idle`);
					// Use whatever we have
					if (runState.stopReason === "stop" || runState.stopReason === "toolUse") {
						log.logInfo(`[run] using last known stopReason=${runState.stopReason} despite timeout`);
					} else {
						runState.stopReason = "error";
						runState.errorMessage = "session.prompt() timed out after 45s";
					}
				} else {
					log.logInfo(`[perf] session.prompt completed: ${(performance.now() - tPrompt).toFixed(0)}ms, stopReason=${runState.stopReason}`);
				}
			} catch (promptErr) {
				const errMsg = promptErr instanceof Error ? promptErr.message : String(promptErr);
				const stack = promptErr instanceof Error ? promptErr.stack : undefined;
				log.logWarning(`[run] session.prompt() threw: ${errMsg}${stack ? `\n${stack}` : ""}`);
				runState.stopReason = "error";
				runState.errorMessage = errMsg;
			}

			// If overflow error triggered background compaction+retry, wait for it.
			// Agent.emit() doesn't await async handlers, so _runAutoCompaction runs
			// detached. waitForIdle() waits for any in-flight agent.continue() call.
			if (runState.stopReason === "error") {
				log.logInfo(`[run] stopReason=error, waiting for agent idle (background compaction/retry)...`);
				await agent.waitForIdle();
				log.logInfo(`[run] agent idle reached`);

				// Re-read result — background retry may have succeeded
				const msgs = currentSession.messages;
				const last = msgs.filter((m) => m.role === "assistant").pop() as any;
				if (last && last.stopReason && last.stopReason !== "error") {
					log.logInfo(`[run] background retry succeeded, new stopReason=${last.stopReason}`);
					runState.stopReason = last.stopReason;
					runState.errorMessage = undefined;
				}
			}

			// Wait for queued messages
			log.logInfo(`[run] waiting for queued messages...`);
			await queueChain;
			log.logInfo(`[run] queue drained`);

			// Handle error case - update main message and post error to thread
			log.logInfo(`[run] post-prompt: stopReason=${runState.stopReason} errorMessage=${runState.errorMessage || "none"}`);
			if (runState.stopReason === "error" && runState.errorMessage) {
				log.logInfo(`[run] sending error response to channel`);
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

				log.logInfo(`[run] finalText length=${finalText.length} preview=${finalText.substring(0, 100)}`);

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					log.logInfo(`[run] calling sendFinalResponse (${finalText.length} chars)`);
					try {
						const mainText =
							finalText.length > MAX_MESSAGE_LENGTH
								? `${finalText.substring(0, MAX_MESSAGE_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.sendFinalResponse(mainText);
						log.logInfo(`[run] sendFinalResponse completed`);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				} else {
					log.logInfo(`[run] no final text to send (empty response)`);
				}
			}

			// Log usage summary with context info
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
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
					log.logWarning(`[${channelId}] steer failed`, err.message);
				});
			} else {
				log.logWarning(`[${channelId}] steer called but not streaming, ignoring`);
			}
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
