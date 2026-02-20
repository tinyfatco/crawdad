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
import { downloadChannel } from "./download.js";
import { computeWakeManifest, createEventsWatcher } from "./events.js";
import { Gateway } from "./gateway.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

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

await validateSandbox(sandbox);

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
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string, formatInstructions: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		// Inject send_message tool for heartbeat channel
		const extraTools = channelId === "_heartbeat" ? [heartbeatAdapter.createSendMessageTool()] : [];
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, formatInstructions, parsedArgs.skillsDirs, extraTools),
			store: new ChannelStore({ workingDir, botToken: process.env.MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Handler (shared across all adapters)
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, platform: PlatformAdapter): Promise<void> {
		const state = channelStates.get(channelId);
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
		const state = getState(event.channel, platform.formatInstructions);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${platform.name}:${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context from adapter
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

// Register, init, and mark each adapter ready. Failures don't kill other
// adapters — failed routes stay registered but never marked ready (permanent 503).
for (let i = 0; i < adapters.length; i++) {
	const adapter = adapters[i];
	const adapterName = parsedArgs.adapters[i];
	const path = DISPATCH_PATHS[adapterName];

	if (path && adapter.dispatch) {
		gateway.register(path, (req, res) => adapter.dispatch!(req, res));
	}

	try {
		await adapter.start();
		if (path) {
			gateway.markReady(path);
		}
	} catch (err) {
		log.logWarning(`[${adapter.name}] adapter.start() failed, skipping: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Start events watcher AFTER adapters (may block on slow FS)
// Uses allAdapters so heartbeat events (_heartbeat channelId) get routed correctly
const eventsWatcher = createEventsWatcher(workingDir, allAdapters);
eventsWatcher.start();

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
