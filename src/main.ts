#!/usr/bin/env node

import { join, resolve } from "path";
import { DiscordWebhookAdapter } from "./adapters/discord-webhook.js";
import { EmailWebhookAdapter } from "./adapters/email-webhook.js";
import { HeartbeatAdapter, HEARTBEAT_CHANNEL_ID } from "./adapters/heartbeat.js";
import { SlackSocketAdapter } from "./adapters/slack-socket.js";
import { SlackWebhookAdapter } from "./adapters/slack-webhook.js";
import { TelegramPollingAdapter } from "./adapters/telegram-polling.js";
import { TelegramWebhookAdapter } from "./adapters/telegram-webhook.js";
import { VoiceAdapter } from "./adapters/voice.js";
import { WebAdapter } from "./adapters/web.js";
import { WebVoiceBridgeAdapter, handleWebVoiceSession } from "./adapters/web-voice.js";
import { handleTerminalUpgrade } from "./terminal.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "./adapters/types.js";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { handleSlashCommand } from "./commands.js";
import { MomSettingsManager } from "./context.js";
import { downloadChannel } from "./download.js";
import { ChannelPulse } from "./engagement/channel-pulse.js";
import { computeWakeManifest, createEventsWatcher } from "./events.js";
import { Gateway } from "./gateway.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { createPingTool } from "./tools/ping.js";
import { createSetWorkingChannelTool } from "./tools/set-working-channel.js";
import { createYieldNoActionTool } from "./tools/yield-no-action.js";

// ============================================================================
// Channel labeling — human-readable names for messages in the awareness context
// ============================================================================

/**
 * Get a human-readable label for a channel, including adapter type.
 * Used for tagging messages in the unified awareness context.
 */
/** Discord snowflake IDs are 17-20 digit numbers (vs Telegram's shorter numeric IDs) */
function isDiscordSnowflake(id: string): boolean {
	return /^\d{17,20}$/.test(id);
}

function getChannelLabel(channelId: string, adaptersList: PlatformAdapter[]): string {
	for (const adapter of adaptersList) {
		const ch = adapter.getChannel(channelId);
		if (ch) {
			if (/^[CDG]/.test(channelId)) return `slack:#${ch.name}`;
			if (isDiscordSnowflake(channelId)) return `discord:#${ch.name}`;
			if (/^-?\d+$/.test(channelId)) return `telegram:${ch.name}`;
			if (channelId.startsWith("email-")) return `email:${channelId.replace("email-", "")}`;
			if (channelId.startsWith("web-")) return `web:${ch.name}`;
			if (channelId.startsWith("voice-")) return `voice:${ch.name}`;
			if (channelId === "heartbeat") return `heartbeat:${ch.name}`;
			return ch.name;
		}
	}
	// Fallback for unknown channels
	if (channelId === "heartbeat") return `heartbeat:heartbeat`;
	if (/^[CDG]/.test(channelId)) return `slack:${channelId}`;
	if (isDiscordSnowflake(channelId)) return `discord:${channelId}`;
	if (/^-?\d+$/.test(channelId)) return `telegram:${channelId}`;
	if (channelId.startsWith("email-")) return `email:${channelId.replace("email-", "")}`;
	if (channelId.startsWith("web-")) return `web:${channelId}`;
	if (channelId.startsWith("voice-")) return `voice:${channelId}`;
	return channelId;
}

/**
 * Get a short display name for a channel (used in attention pointer).
 */
function getChannelDisplayName(channelId: string, adaptersList: PlatformAdapter[]): string {
	for (const adapter of adaptersList) {
		const ch = adapter.getChannel(channelId);
		if (ch) {
			if (/^[CDG]/.test(channelId)) return `#${ch.name}`;
			if (isDiscordSnowflake(channelId)) return `discord:#${ch.name}`;
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
	uiDir?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let adapterArg: string | undefined;
	let port: number | undefined;
	let uiDir: string | undefined;
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
		} else if (arg.startsWith("--ui=")) {
			uiDir = resolve(arg.slice("--ui=".length));
		} else if (arg === "--ui") {
			uiDir = resolve(args[++i] || "");
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
		if (process.env.MOM_DISCORD_BOT_TOKEN && process.env.MOM_DISCORD_APPLICATION_ID && process.env.MOM_DISCORD_PUBLIC_KEY) {
			adapters.push("discord:webhook");
		}
		if (process.env.MOM_EMAIL_TOOLS_TOKEN) {
			adapters.push("email:webhook");
		}
		if (process.env.MOM_WEB_CHAT === "true") {
			adapters.push("web");
		}
		if (process.env.MOM_ELEVENLABS_API_KEY) {
			adapters.push("voice");
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
		uiDir,
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

// ============================================================================
// Channel Pulse — shared activity tracker for ambient engagement
// ============================================================================

// Pulse is created early with a placeholder selfId. Updated after Slack auth.
const pulse = new ChannelPulse("pending");

// Cooldown: after an ambient engagement, don't re-evaluate for this many ms
const AMBIENT_COOLDOWN_MS = 45_000; // 45 seconds
const ambientCooldowns = new Map<string, number>();

/** Called by Slack adapters when a non-self, non-mention message arrives in a channel. */
function handleAmbientMessage(channelId: string, event: MomEvent): void {
	// Don't ambient-engage in DMs — those are handled directly
	if (channelId.startsWith("D")) return;

	// Check cooldown
	const lastAmbient = ambientCooldowns.get(channelId) ?? 0;
	if (Date.now() - lastAmbient < AMBIENT_COOLDOWN_MS) return;

	// Check if agent is currently running
	if (awareness?.running) return;

	// Check pulse: have I spoken recently? (< 45s = too soon)
	const timeSince = pulse.timeSinceMyLast(channelId);
	if (timeSince < AMBIENT_COOLDOWN_MS) return;

	// All gates passed — fire ambient engagement
	ambientCooldowns.set(channelId, Date.now());

	const pulseSummary = pulse.summary(channelId);
	log.logInfo(`[ambient:${channelId}] Evaluating engagement (temp=${pulseSummary.temperature}, sinceMyLast=${Math.round(pulseSummary.timeSinceMyLastMs / 1000)}s, participants=${pulseSummary.recentParticipants})`);

	// Find the Slack adapter that owns this channel
	const slackAdapter = adapters.find((a) => a.name === "slack" && a.getChannel(channelId));
	if (!slackAdapter) return;

	// Create an ambient event — the agent decides whether to speak
	const ambientEvent: MomEvent = {
		type: "mention",
		channel: channelId,
		ts: event.ts,
		user: event.user,
		text: `[AMBIENT] A conversation is happening in this channel. Here's the latest message:\n\n${event.text}\n\nChannel pulse: ${pulseSummary.temperature} messages in last 15min, ${pulseSummary.recentParticipants} participants, you last spoke ${pulseSummary.timeSinceMyLastMs === Infinity ? "never" : Math.round(pulseSummary.timeSinceMyLastMs / 1000) + "s ago"}.\n\nYou're observing this conversation naturally. If you have something genuinely useful, interesting, or fun to add — respond naturally as a participant. Keep it brief and conversational. If you have nothing to add, respond with exactly: PASS`,
	};

	const queue = (slackAdapter as any).getQueue?.(channelId);
	if (queue) {
		queue.enqueue(async () => {
			// Re-check: agent might have started running while queued
			if (awareness?.running) return;
			await handler.handleEvent(ambientEvent, slackAdapter);
		});
	}
}

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
			return new SlackSocketAdapter({ appToken, botToken, workingDir, store, pulse, onAmbientMessage: handleAmbientMessage });
		}
		case "slack:webhook": {
			const botToken = process.env.MOM_SLACK_BOT_TOKEN;
			const signingSecret = process.env.MOM_SLACK_SIGNING_SECRET;
			if (!botToken || !signingSecret) {
				console.error("Missing env: MOM_SLACK_BOT_TOKEN, MOM_SLACK_SIGNING_SECRET");
				process.exit(1);
			}
			const store = new ChannelStore({ workingDir, botToken });
			return new SlackWebhookAdapter({ botToken, workingDir, store, signingSecret, pulse, onAmbientMessage: handleAmbientMessage });
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
		case "discord:webhook": {
			const discordBotToken = process.env.MOM_DISCORD_BOT_TOKEN;
			const discordAppId = process.env.MOM_DISCORD_APPLICATION_ID;
			const discordPublicKey = process.env.MOM_DISCORD_PUBLIC_KEY;
			if (!discordBotToken || !discordAppId || !discordPublicKey) {
				console.error("Missing env: MOM_DISCORD_BOT_TOKEN, MOM_DISCORD_APPLICATION_ID, MOM_DISCORD_PUBLIC_KEY");
				process.exit(1);
			}
			return new DiscordWebhookAdapter({ botToken: discordBotToken, applicationId: discordAppId, publicKey: discordPublicKey, workingDir });
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
		case "voice": {
			const elevenLabsKey = process.env.MOM_ELEVENLABS_API_KEY;
			const elevenLabsVoice = process.env.MOM_ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default: Rachel
			const elevenLabsModel = process.env.MOM_ELEVENLABS_MODEL_ID;
			if (!elevenLabsKey) {
				console.error("Missing env: MOM_ELEVENLABS_API_KEY");
				process.exit(1);
			}
			return new VoiceAdapter({
				workingDir,
				elevenlabsApiKey: elevenLabsKey,
				elevenlabsVoiceId: elevenLabsVoice,
				elevenlabsModelId: elevenLabsModel,
			});
		}
		default:
			console.error(`Unknown adapter: ${name}. Use 'slack', 'slack:socket', 'slack:webhook', 'telegram', 'telegram:polling', 'telegram:webhook', 'discord:webhook', 'email:webhook', 'web', or 'voice'.`);
			process.exit(1);
	}
}

const adapters: AdapterWithHandler[] = parsedArgs.adapters.map(createAdapter);

// Always create heartbeat adapter — implicit, not user-configured
const heartbeatAdapter = new HeartbeatAdapter({ workingDir }) as AdapterWithHandler;
adapters.push(heartbeatAdapter);

// ============================================================================
// Awareness — single unified state for the agent
// ============================================================================

const AWARENESS_DIR = "awareness";

interface Awareness {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
	/** The display channel where output is currently routed (real channel ID) */
	displayChannelId: string;
	/** The adapter currently handling display output */
	displayAdapter: PlatformAdapter;
}

let awareness: Awareness | null = null;

function getAwareness(channelId: string, adapter: PlatformAdapter, formatInstructions: string): Awareness {
	if (!awareness) {
		const awarenessDir = join(workingDir, AWARENESS_DIR);
		const extraTools = [
			createPingTool(adapters),
			createYieldNoActionTool(),
			createSetWorkingChannelTool(adapters, (newChannelId: string) => {
				for (const a of adapters) {
					const channel = a.getChannel(newChannelId);
					if (channel) {
						if (awareness) {
							awareness.displayChannelId = newChannelId;
							awareness.displayAdapter = a;
						}
						return getChannelDisplayName(newChannelId, adapters);
					}
				}
				return undefined;
			}),
		];

		awareness = {
			running: false,
			runner: getOrCreateRunner(
				sandbox,
				awarenessDir,
				formatInstructions,
				parsedArgs.skillsDirs,
				extraTools,
			),
			store: new ChannelStore({ workingDir, botToken: process.env.MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
			displayChannelId: channelId,
			displayAdapter: adapter,
		};
	}
	// Update display channel to wherever the latest message came from
	awareness.displayChannelId = channelId;
	awareness.displayAdapter = adapter;
	return awareness;
}

// ============================================================================
// Handler (shared across all adapters)
// ============================================================================

const handler: MomHandler = {
	isRunning(_channelId: string): boolean {
		return awareness?.running ?? false;
	},

	handleSteer(event: MomEvent, adapter: PlatformAdapter): void {
		if (!awareness?.running) {
			log.logWarning(`[steer] handleSteer called but awareness not running`);
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

		// Tag with source channel for awareness
		const isCrossChannel = event.channel !== awareness.displayChannelId;
		const channelLabel = getChannelLabel(event.channel, adapters);
		let formattedMessage: string;

		if (isCrossChannel) {
			const currentLabel = getChannelDisplayName(awareness.displayChannelId, adapters);
			formattedMessage = `[${timestamp}] [${channelLabel}] [${userName}]: ${event.text}`;

			// Directive steering prompt — always ping, shift on urgency
			formattedMessage += `\n\n---\n[HARNESS] A message arrived from ${channelLabel} while you are attending to ${currentLabel}.\n\nREQUIRED: Use the \`ping\` tool to acknowledge the sender on ${channelLabel} immediately. A short "Got it, working on something — one moment" is fine. Never leave a cross-channel message unacknowledged.\n\nIf the message is urgent or more important than your current task, also call \`set_working_channel\` to shift your attention to ${channelLabel} and abandon your current task — you can resume it later.`;
		} else {
			formattedMessage = `[${timestamp}] [${channelLabel}] [${userName}]: ${event.text}`;
		}

		log.logInfo(`[steer:${event.channel}] Steering message into active run: ${event.text.substring(0, 50)}`);
		awareness.runner.steer(formattedMessage);
	},

	async handleStop(channelId: string, platform: PlatformAdapter): Promise<void> {
		if (awareness?.running) {
			awareness.stopRequested = true;
			awareness.runner.abort();
			const ts = await platform.postMessage(channelId, "_Stopping..._");
			awareness.stopMessageTs = ts;
		} else {
			await platform.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: MomEvent, platform: PlatformAdapter, isEvent?: boolean): Promise<void> {
		// Ensure awareness is initialized (needed for /context and other commands)
		const state = getAwareness(event.channel, platform, platform.formatInstructions);

		// Intercept slash commands before spinning up the agent
		const trimmed = event.text.trim();
		if (trimmed.startsWith("/") && !isEvent) {
			const handled = await handleSlashCommand(trimmed, event.channel, workingDir, platform, state.runner);
			if (handled) return;
		}

		// Start run
		state.running = true;
		state.stopRequested = false;

		const channelLabel = getChannelLabel(event.channel, adapters);
		log.logInfo(`[${platform.name}:${event.channel}] Starting run (${channelLabel}): ${event.text.substring(0, 50)}`);

		try {
			// Create context from adapter — targets the DISPLAY channel (real channel ID)
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

// Route map: webhook adapters register their dispatch path with the gateway
const DISPATCH_PATHS: Record<string, string> = {
	"slack:webhook": "/slack/events",
	"telegram:webhook": "/telegram/webhook",
	"discord:webhook": "/discord/interactions",
	"email:webhook": "/email/inbound",
	"web": "/web/chat",
};

// Start gateway — binds HTTP port before adapter init so callers can
// detect the port is up. Routes return 503 until their adapter is ready.
const gateway = new Gateway({
	uiDir: parsedArgs.uiDir,
	workspaceDir: workingDir,
});

// Status endpoint — reports whether the agent is currently running.
gateway.registerGet("/status", async (_req, res) => {
	const running = awareness?.running ? [AWARENESS_DIR] : [];
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

// Register native terminal PTY — provides /terminal WebSocket in standalone mode.
// When crawdad-cf is in front, it intercepts /agents/{id}/terminal at the Worker
// level (sandbox.terminal()) so this handler never fires.
gateway.registerUpgrade("/terminal", handleTerminalUpgrade(workingDir));

await gateway.start(parsedArgs.port);
log.logInfo(`[perf] gateway listening: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// Start voice WebSocket server early (port 8765) so it's ready before adapters init.
// The voice adapter will attach its handler when it starts. This ensures the port is
// bound immediately so the orchestrator's readiness check passes during cold start.
if (parsedArgs.adapters.includes("voice")) {
	const { createServer } = await import("http");
	const { WebSocketServer } = await import("ws");
	const earlyWsServer = createServer();
	const earlyWss = new WebSocketServer({ server: earlyWsServer });

	// Hold connections until the voice adapter is ready to handle them
	const pendingConnections: import("ws").WebSocket[] = [];
	earlyWss.on("connection", (ws) => {
		log.logInfo("[voice-early] Connection received, holding until adapter ready");
		pendingConnections.push(ws);
	});

	await new Promise<void>((resolve) => {
		earlyWsServer.listen(8765, () => {
			log.logInfo("[voice-early] Port 8765 bound (pre-adapter)");
			resolve();
		});
	});

	// Expose for the voice adapter to take over
	(globalThis as any).__voiceEarlyServer = { server: earlyWsServer, wss: earlyWss, pendingConnections };
}

// Register web voice chat — browser mic → STT → agent → TTS → browser speakers.
// Runs on its own port (8766) since Cloudflare container proxying requires a dedicated port.
// Always available when ElevenLabs API key is set (no need for --adapter=voice).
if (process.env.MOM_ELEVENLABS_API_KEY) {
	const { createServer: createHttpServer } = await import("http");
	const { WebSocketServer } = await import("ws");
	const webVoiceServer = createHttpServer();
	const wss = new WebSocketServer({ server: webVoiceServer });
	const webVoiceAdapter = new WebVoiceBridgeAdapter(workingDir);
	webVoiceAdapter.setHandler(handler);
	adapters.push(webVoiceAdapter as unknown as AdapterWithHandler);

	wss.on("connection", (ws) => {
		handleWebVoiceSession(ws, {
			elevenlabsApiKey: process.env.MOM_ELEVENLABS_API_KEY!,
			elevenlabsVoiceId: process.env.MOM_ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
			elevenlabsModelId: process.env.MOM_ELEVENLABS_MODEL_ID,
			workingDir,
		}, handler, webVoiceAdapter);
	});

	await new Promise<void>((resolve) => {
		webVoiceServer.listen(8766, () => {
			log.logInfo("[web-voice] WebSocket server listening on port 8766");
			resolve();
		});
	});
}

// Register routes first (so gateway can accept traffic), then start adapters in parallel.
// Each adapter starts independently — a slow Slack backfill doesn't block Telegram.
for (let i = 0; i < adapters.length; i++) {
	const adapter = adapters[i];
	const adapterName = parsedArgs.adapters[i];
	const path = DISPATCH_PATHS[adapterName];

	if (path && adapter.dispatch) {
		gateway.register(path, (req, res) => adapter.dispatch!(req, res));
		// Discord: also register /discord/messages for Gateway relay traffic
		if (adapterName === "discord:webhook") {
			gateway.register("/discord/messages", (req, res) => adapter.dispatch!(req, res));
		}
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
		// Discord: also mark /discord/messages as ready
		if (adapterName === "discord:webhook") {
			gateway.markReady("/discord/messages");
		}
		log.logInfo(`[perf] ${adapter.name} started: ${(performance.now() - t).toFixed(0)}ms`);
	} catch (err) {
		log.logWarning(`[${adapter.name}] adapter.start() failed, skipping: ${err instanceof Error ? err.message : String(err)}`);
	}
}));
log.logInfo(`[perf] all adapters started: ${(performance.now() - T_BOOT).toFixed(0)}ms`);

// Write heartbeat event file from settings.json on every boot (settings is authoritative)
{
	const { existsSync, mkdirSync, writeFileSync, unlinkSync } = await import("fs");
	const settings = new MomSettingsManager(workingDir);
	const spontaneity = settings.getSpontaneitySettings();
	const eventsDir = join(workingDir, "events");
	const heartbeatFile = join(eventsDir, "heartbeat.json");

	if (spontaneity.enabled) {
		if (!existsSync(eventsDir)) {
			mkdirSync(eventsDir, { recursive: true });
		}
		const tz = spontaneity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
		// Convert interval to valid cron (minutes field only supports 0-59)
		let schedule: string;
		const mins = spontaneity.intervalMinutes;
		if (mins < 60) {
			schedule = `*/${mins} * * * *`;
		} else if (mins < 1440) {
			const hours = Math.max(1, Math.round(mins / 60));
			schedule = `0 */${hours} * * *`;
		} else {
			schedule = `0 8 * * *`; // daily at 8am
		}

		const event = {
			type: "periodic",
			channelId: HEARTBEAT_CHANNEL_ID,
			text: "[heartbeat] Spontaneous reflection",
			schedule,
			timezone: tz,
			spontaneity: spontaneity.spontaneity,
			quietHours: spontaneity.quietHours,
		};
		writeFileSync(heartbeatFile, JSON.stringify(event, null, 2), "utf-8");
		log.logInfo(`Wrote heartbeat.json (every ${spontaneity.intervalMinutes}min, spontaneity=${spontaneity.spontaneity}, tz=${tz})`);
	} else if (existsSync(heartbeatFile)) {
		// Spontaneity disabled — remove heartbeat event file
		unlinkSync(heartbeatFile);
		log.logInfo("Removed heartbeat.json (spontaneity disabled)");
	}
}

// Start events watcher AFTER seeding (so it picks up heartbeat.json immediately)
const eventsWatcher = createEventsWatcher(workingDir, adapters);
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
