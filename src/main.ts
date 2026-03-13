#!/usr/bin/env node

import { join, resolve } from "path";
import { EmailWebhookAdapter } from "./adapters/email-webhook.js";
import { HeartbeatAdapter } from "./adapters/heartbeat.js";
import { SlackSocketAdapter } from "./adapters/slack-socket.js";
import { SlackWebhookAdapter } from "./adapters/slack-webhook.js";
import { TelegramPollingAdapter } from "./adapters/telegram-polling.js";
import { TelegramWebhookAdapter } from "./adapters/telegram-webhook.js";
import { WebAdapter } from "./adapters/web.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "./adapters/types.js";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { handleSlashCommand } from "./commands.js";
import { downloadChannel } from "./download.js";
import { computeWakeManifest, createEventsWatcher } from "./events.js";
import { Gateway } from "./gateway.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { createSendMessageTool } from "./tools/send-message.js";
import { createSetWorkingChannelTool } from "./tools/set-working-channel.js";

// ============================================================================
// Trunk resolution — all external channels share one runner/context
// ============================================================================

const TRUNK_KEY = "_trunk";
const HEARTBEAT_KEY = "_heartbeat";

/** Returns true if the channelId looks like a Slack channel (C/D/G prefix) */
function isSlackChannel(channelId: string): boolean {
	return /^[CDG]/.test(channelId);
}

/**
 * Resolve a channelId to its trunk key.
 * All external channels (Slack, Telegram, Email, Web) map to the unified trunk.
 * Only _heartbeat stays separate (internal meditation state).
 */
function resolveTrunk(channelId: string): string {
	return channelId === HEARTBEAT_KEY ? HEARTBEAT_KEY : TRUNK_KEY;
}

/**
 * Get a human-readable label for a channel, including adapter type.
 * Used for tagging messages in the trunk context.
 */
function getChannelLabel(channelId: string, adapter: PlatformAdapter): string {
	if (isSlackChannel(channelId)) {
		const name = adapter.getChannel(channelId)?.name || channelId;
		return `#${name} | ${channelId}`;
	}
	if (/^-?\d+$/.test(channelId)) {
		const name = adapter.getChannel(channelId)?.name || channelId;
		return `Telegram:${name}`;
	}
	if (channelId.startsWith("email-")) {
		return `Email:${channelId.replace("email-", "")}`;
	}
	if (channelId.startsWith("web-")) {
		return `Web:${channelId}`;
	}
	return channelId;
}

/**
 * Get a short display name for a channel (used in attention pointer).
 */
function getChannelDisplayName(channelId: string, adaptersList: PlatformAdapter[]): string {
	for (const adapter of adaptersList) {
		const ch = adapter.getChannel(channelId);
		if (ch) {
			if (isSlackChannel(channelId)) return `#${ch.name}`;
			return `${adapter.name}:${ch.name}`;
		}
	}
	return channelId;
}

// ============================================================================
// Config
// ============================================================================

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	adapters: string[];
	port: number;
	skillsDirs: string[];
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let adapterArg: string | undefined;
	let port: number | undefined;
	const skillsDirs: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--adapter=")) {
			adapterArg = arg.slice("--adapter=".length);
		} else if (arg === "--adapter") {
			adapterArg = args[++i] || undefined;
		} else if (arg.startsWith("--port=")) {
			port = parseInt(arg.slice("--port=".length), 10);
		} else if (arg === "--port") {
			port = parseInt(args[++i] || "", 10);
		} else if (arg.startsWith("--skills=")) {
			skillsDirs.push(resolve(arg.slice("--skills=".length)));
		} else if (arg === "--skills") {
			skillsDirs.push(resolve(args[++i] || ""));
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	// If --adapter specified, use it (comma-separated). Otherwise auto-detect from env vars.
	// "slack" alone = "slack:socket" for backwards compat.
	let adapters: string[];
	if (adapterArg) {
		adapters = adapterArg.split(",").map((a) => a.trim());
	} else {
		adapters = [];
		if (process.env.MOM_SLACK_APP_TOKEN && process.env.MOM_SLACK_BOT_TOKEN) {
			adapters.push("slack");
		}
		if (process.env.MOM_SLACK_SIGNING_SECRET && process.env.MOM_SLACK_BOT_TOKEN) {
			// Auto-detect webhook mode if signing secret is set (and no app token)
			if (!adapters.includes("slack")) {
				adapters.push("slack:webhook");
			}
		}
		if (process.env.MOM_TELEGRAM_BOT_TOKEN) {
			// Prefer webhook mode when secret is set (external orchestrator sets this)
			if (process.env.MOM_TELEGRAM_WEBHOOK_SECRET) {
				adapters.push("telegram:webhook");
			} else {
				adapters.push("telegram");
			}
		}
		if (process.env.MOM_EMAIL_TOOLS_TOKEN) {
			adapters.push("email:webhook");
		}
		if (process.env.MOM_WEB_CHAT === "true") {
			adapters.push("web");
		}
		// Default to slack if nothing detected
		if (adapters.length === 0) {
			adapters.push("slack");
		}
	}

	const resolvedPort = port || parseInt(process.env.MOM_HTTP_PORT || "", 10) || 3000;

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		adapters,
		port: resolvedPort,
		skillsDirs,
	};
}

const T_BOOT = performance.now();
const parsedArgs = parseArgs();

// Handle --download mode (Slack-only for now)
if (parsedArgs.downloadChannel) {
	const botToken = process.env.MOM_SLACK_BOT_TOKEN;
	if (!botToken) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, botToken);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] [--adapter=slack:socket,telegram:webhook] [--port=3000] [--skills=<dir>] <working-directory>");
	console.error("       mom --download <channel-id>");
	console.error("       Adapters: slack (=slack:socket), slack:webhook, telegram (=telegram:polling), telegram:webhook");
	console.error("       --skills: Additional skills directory to scan (can be specified multiple times)");
	console.error("       (omit --adapter to auto-detect from env vars)");
	process.exit(1);
}

const { workingDir, sandbox } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
};

log.logInfo(`[perf] args parsed: ${(performance.now() - T_BOOT).toFixed(0)}ms`);
await validateSandbox(sandbox);
log.logInfo(`[perf] sandbox validated: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// ============================================================================
// Create platform adapters
// ============================================================================

type AdapterWithHandler = PlatformAdapter & { setHandler(h: MomHandler): void };

function createAdapter(name: string): AdapterWithHandler {
	switch (name) {
		case "slack":
		case "slack:socket": {
			const appToken = process.env.MOM_SLACK_APP_TOKEN;
			const botToken = process.env.MOM_SLACK_BOT_TOKEN;
			if (!appToken || !botToken) {
				console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
				process.exit(1);
			}
			const store = new ChannelStore({ workingDir, botToken });
			return new SlackSocketAdapter({ appToken, botToken, workingDir, store });
		}
		case "slack:webhook": {
			const botToken = process.env.MOM_SLACK_BOT_TOKEN;
			const signingSecret = process.env.MOM_SLACK_SIGNING_SECRET;
			if (!botToken || !signingSecret) {
				console.error("Missing env: MOM_SLACK_BOT_TOKEN, MOM_SLACK_SIGNING_SECRET");
				process.exit(1);
			}
			const store = new ChannelStore({ workingDir, botToken });
			return new SlackWebhookAdapter({ botToken, workingDir, store, signingSecret });
		}
		case "telegram":
		case "telegram:polling": {
			const botToken = process.env.MOM_TELEGRAM_BOT_TOKEN;
			if (!botToken) {
				console.error("Missing env: MOM_TELEGRAM_BOT_TOKEN");
				process.exit(1);
			}
			return new TelegramPollingAdapter({ botToken, workingDir });
		}
		case "telegram:webhook": {
			const botToken = process.env.MOM_TELEGRAM_BOT_TOKEN;
			const webhookUrl = process.env.MOM_TELEGRAM_WEBHOOK_URL;
			const webhookSecret = process.env.MOM_TELEGRAM_WEBHOOK_SECRET;
			const skipRegistration = !!process.env.MOM_SKIP_WEBHOOK_REGISTRATION;
			if (!botToken || !webhookSecret) {
				console.error("Missing env: MOM_TELEGRAM_BOT_TOKEN, MOM_TELEGRAM_WEBHOOK_SECRET");
				process.exit(1);
			}
			if (!skipRegistration && !webhookUrl) {
				console.error("Missing env: MOM_TELEGRAM_WEBHOOK_URL (required unless MOM_SKIP_WEBHOOK_REGISTRATION=true)");
				process.exit(1);
			}
			return new TelegramWebhookAdapter({ botToken, workingDir, webhookUrl, webhookSecret, skipRegistration });
		}
		case "email:webhook": {
			const toolsToken = process.env.MOM_EMAIL_TOOLS_TOKEN;
			if (!toolsToken) {
				console.error("Missing env: MOM_EMAIL_TOOLS_TOKEN");
				process.exit(1);
			}
			const sendUrl = process.env.MOM_EMAIL_SEND_URL || "https://tinyfat.com/api/email/send";
			return new EmailWebhookAdapter({ workingDir, toolsToken, sendUrl });
		}
		case "web": {
			return new WebAdapter({ workingDir });
		}
		default:
			console.error(`Unknown adapter: ${name}. Use 'slack', 'slack:socket', 'slack:webhook', 'telegram', 'telegram:polling', 'telegram:webhook', 'email:webhook', or 'web'.`);
			process.exit(1);
	}
}

const adapters: AdapterWithHandler[] = parsedArgs.adapters.map(createAdapter);

// Create heartbeat adapter — lives alongside other adapters but is purely internal
const heartbeatAdapter = new HeartbeatAdapter({ workingDir });

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
	/** The display channel where output is currently routed (real channel ID, not trunk key) */
	displayChannelId: string;
}

const channelStates = new Map<string, ChannelState>();

/**
 * Get the channel name resolver for tagging messages with source channel.
 * Reads from ALL adapters — Slack, Telegram, Email, Web.
 */
function getChannelNameMap(): Map<string, string> {
	const map = new Map<string, string>();
	for (const adapter of adapters) {
		for (const ch of adapter.getAllChannels()) {
			if (isSlackChannel(ch.id)) {
				map.set(ch.id, `#${ch.name}`);
			} else if (/^-?\d+$/.test(ch.id)) {
				map.set(ch.id, `Telegram:${ch.name}`);
			} else if (ch.id.startsWith("email-")) {
				map.set(ch.id, `Email:${ch.id.replace("email-", "")}`);
			} else if (ch.id.startsWith("web-")) {
				map.set(ch.id, `Web:${ch.name}`);
			} else {
				map.set(ch.id, ch.name);
			}
		}
	}
	return map;
}

function getState(channelId: string, formatInstructions: string): ChannelState {
	const trunkKey = resolveTrunk(channelId);
	let state = channelStates.get(trunkKey);
	if (!state) {
		const isTrunk = trunkKey === TRUNK_KEY;
		const channelDir = join(workingDir, trunkKey);
		// send_message available on ALL channels for cross-channel messaging
		const extraTools = [createSendMessageTool(adapters)];

		// For trunk, also add set_working_channel tool
		// We need a reference to state for the callback, so we create it in two steps
		const stateRef: { current: ChannelState | null } = { current: null };
		if (isTrunk) {
			extraTools.push(createSetWorkingChannelTool(adapters, (newChannelId: string) => {
				// Look across all adapters for the channel
				for (const adapter of adapters) {
					const channel = adapter.getChannel(newChannelId);
					if (channel) {
						if (stateRef.current) {
							stateRef.current.displayChannelId = newChannelId;
						}
						return getChannelDisplayName(newChannelId, adapters);
					}
				}
				return undefined;
			}));
		}

		state = {
			running: false,
			runner: getOrCreateRunner(
				sandbox,
				trunkKey,
				channelDir,
				formatInstructions,
				parsedArgs.skillsDirs,
				extraTools,
				isTrunk ? getChannelNameMap() : undefined,
			),
			store: new ChannelStore({ workingDir, botToken: process.env.MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
			displayChannelId: channelId,
		};
		stateRef.current = state;
		channelStates.set(trunkKey, state);
	}
	// Update display channel to wherever the latest message came from
	state.displayChannelId = channelId;
	return state;
}

// ============================================================================
// Handler (shared across all adapters)
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const trunkKey = resolveTrunk(channelId);
		const state = channelStates.get(trunkKey);
		return state?.running ?? false;
	},

	handleSteer(event: MomEvent, adapter: PlatformAdapter): void {
		const trunkKey = resolveTrunk(event.channel);
		const state = channelStates.get(trunkKey);
		if (!state?.running) {
			log.logWarning(`[steer] handleSteer called but trunk ${trunkKey} not running`);
			return;
		}

		// Format the message with timestamp
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, "0");
		const offset = -now.getTimezoneOffset();
		const offsetSign = offset >= 0 ? "+" : "-";
		const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
		const offsetMins = pad(Math.abs(offset) % 60);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;

		// Resolve user name from adapter metadata
		const user = adapter.getUser(event.user);
		const userName = user?.userName || event.user || "unknown";

		// Tag with source channel for trunk awareness
		const isCrossChannel = event.channel !== state.displayChannelId;
		let formattedMessage: string;

		if (isCrossChannel) {
			const channelLabel = getChannelLabel(event.channel, adapter);
			const currentLabel = getChannelDisplayName(state.displayChannelId, adapters);
			formattedMessage = `[${timestamp}] [${channelLabel}] [${userName}]: ${event.text}`;

			// Add harness proposal for attention shift
			formattedMessage += `\n\n---\n[HARNESS] A message just arrived from ${channelLabel} while you were attending to ${currentLabel}. You can:\n- Respond naturally here (your output goes to ${currentLabel})\n- Use send_message to acknowledge them on ${channelLabel}\n- Use set_working_channel to shift your attention there\nDecide based on urgency and context.`;
		} else {
			formattedMessage = `[${timestamp}] [${userName}]: ${event.text}`;
		}

		log.logInfo(`[steer:${event.channel}→${trunkKey}] Steering message into active run: ${event.text.substring(0, 50)}`);
		state.runner.steer(formattedMessage);
	},

	async handleStop(channelId: string, platform: PlatformAdapter): Promise<void> {
		const trunkKey = resolveTrunk(channelId);
		const state = channelStates.get(trunkKey);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await platform.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts;
		} else {
			await platform.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: MomEvent, platform: PlatformAdapter, isEvent?: boolean): Promise<void> {
		// Intercept slash commands before spinning up the agent
		const trimmed = event.text.trim();
		if (trimmed.startsWith("/") && !isEvent) {
			const handled = await handleSlashCommand(trimmed, event.channel, workingDir, platform);
			if (handled) return;
		}

		const state = getState(event.channel, platform.formatInstructions);

		// For trunk channels, the runner tags messages with source channel in the context
		// (no event mutation needed — tagging happens in agent.ts user message construction)

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${platform.name}:${event.channel}] Starting run (trunk: ${resolveTrunk(event.channel)}): ${event.text.substring(0, 50)}`);

		try {
			// Create context from adapter — targets the DISPLAY channel (real Slack channel)
			const ctx = platform.createContext(event, state.store, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await platform.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await platform.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(
				`[${platform.name}:${event.channel}] Run error`,
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
log.logInfo(`Adapters: ${parsedArgs.adapters.join(", ")}`);
if (parsedArgs.skillsDirs.length > 0) {
	log.logInfo(`Extra skills dirs: ${parsedArgs.skillsDirs.join(", ")}`);
}

for (const adapter of adapters) {
	adapter.setHandler(handler);
}

// Wire up heartbeat adapter — give it handler + references to all channel adapters
heartbeatAdapter.setHandler(handler);
heartbeatAdapter.setOtherAdapters(adapters);

// All adapters including heartbeat — EventsWatcher iterates this to route events
const allAdapters: PlatformAdapter[] = [...adapters, heartbeatAdapter];

// Route map: webhook adapters register their dispatch path with the gateway
const DISPATCH_PATHS: Record<string, string> = {
	"slack:webhook": "/slack/events",
	"telegram:webhook": "/telegram/webhook",
	"email:webhook": "/email/inbound",
	"web": "/web/chat",
};

// Start gateway — binds HTTP port before adapter init so callers can
// detect the port is up. Routes return 503 until their adapter is ready.
const gateway = new Gateway();

// Status endpoint — reports which channels are currently running.
// Used by the orchestrator to wait for agent idle before re-syncing schedules.
gateway.registerGet("/status", async (_req, res) => {
	const running: string[] = [];
	for (const [channelId, state] of channelStates) {
		if (state.running) running.push(channelId);
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ running, idle: running.length === 0 }));
});

// Schedule endpoint — returns next wake time for scheduled events.
// Used by the orchestrator to set alarms for sleeping containers.
gateway.registerGet("/schedule", async (_req, res) => {
	try {
		const eventsDir = join(workingDir, "events");
		const schedule = await computeWakeManifest(eventsDir);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(schedule));
	} catch (err) {
		res.writeHead(500);
		res.end(JSON.stringify({ error: String(err) }));
	}
});

await gateway.start(parsedArgs.port);
log.logInfo(`[perf] gateway listening: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// Register routes first (so gateway can accept traffic), then start adapters in parallel.
// Each adapter starts independently — a slow Slack backfill doesn't block Telegram.
for (let i = 0; i < adapters.length; i++) {
	const adapter = adapters[i];
	const adapterName = parsedArgs.adapters[i];
	const path = DISPATCH_PATHS[adapterName];

	if (path && adapter.dispatch) {
		gateway.register(path, (req, res) => adapter.dispatch!(req, res));
	}
}

await Promise.all(adapters.map(async (adapter, i) => {
	const adapterName = parsedArgs.adapters[i];
	const path = DISPATCH_PATHS[adapterName];
	const t = performance.now();
	try {
		await adapter.start();
		if (path) {
			gateway.markReady(path);
		}
		log.logInfo(`[perf] ${adapter.name} started: ${(performance.now() - t).toFixed(0)}ms`);
	} catch (err) {
		log.logWarning(`[${adapter.name}] adapter.start() failed, skipping: ${err instanceof Error ? err.message : String(err)}`);
	}
}));
log.logInfo(`[perf] all adapters started: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// Start events watcher AFTER adapters (may block on slow FS)
// Uses allAdapters so heartbeat events (_heartbeat channelId) get routed correctly
const eventsWatcher = createEventsWatcher(workingDir, allAdapters);
eventsWatcher.start();
log.logInfo(`[perf] events watcher started: ${(performance.now() - T_BOOT).toFixed(0)}ms`);
log.logInfo(`[perf] TOTAL STARTUP: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	gateway.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	gateway.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});
