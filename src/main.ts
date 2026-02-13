#!/usr/bin/env node

import { join, resolve } from "path";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "./adapters/types.js";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
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
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let adapterArg: string | undefined;

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
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	// If --adapter specified, use it (comma-separated). Otherwise auto-detect from env vars.
	let adapters: string[];
	if (adapterArg) {
		adapters = adapterArg.split(",").map((a) => a.trim());
	} else {
		adapters = [];
		if (process.env.MOM_SLACK_APP_TOKEN && process.env.MOM_SLACK_BOT_TOKEN) {
			adapters.push("slack");
		}
		if (process.env.MOM_TELEGRAM_BOT_TOKEN) {
			adapters.push("telegram");
		}
		// Default to slack if nothing detected
		if (adapters.length === 0) {
			adapters.push("slack");
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		adapters,
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
	console.error("Usage: mom [--sandbox=host|docker:<name>] [--adapter=slack,telegram] <working-directory>");
	console.error("       mom --download <channel-id>");
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
		case "slack": {
			const appToken = process.env.MOM_SLACK_APP_TOKEN;
			const botToken = process.env.MOM_SLACK_BOT_TOKEN;
			if (!appToken || !botToken) {
				console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
				process.exit(1);
			}
			const store = new ChannelStore({ workingDir, botToken });
			return new SlackAdapter({ appToken, botToken, workingDir, store });
		}
		case "telegram": {
			const botToken = process.env.MOM_TELEGRAM_BOT_TOKEN;
			if (!botToken) {
				console.error("Missing env: MOM_TELEGRAM_BOT_TOKEN");
				process.exit(1);
			}
			return new TelegramAdapter({ botToken, workingDir });
		}
		default:
			console.error(`Unknown adapter: ${name}. Use 'slack' or 'telegram'.`);
			process.exit(1);
	}
}

const adapters: AdapterWithHandler[] = parsedArgs.adapters.map(createAdapter);

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
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, formatInstructions),
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

for (const adapter of adapters) {
	adapter.setHandler(handler);
}

// Start events watcher (routes to all adapters)
const eventsWatcher = createEventsWatcher(workingDir, adapters);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});

// Start all adapters
for (const adapter of adapters) {
	adapter.start();
}
