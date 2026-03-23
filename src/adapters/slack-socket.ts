import { SocketModeClient } from "@slack/socket-mode";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { SlackBase, type SlackBaseConfig } from "./slack-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// SlackSocketAdapter — Socket Mode (persistent WebSocket)
// ============================================================================

export interface SlackSocketAdapterConfig extends SlackBaseConfig {
	appToken: string;
}

export class SlackSocketAdapter extends SlackBase {
	private socketClient: SocketModeClient;

	constructor(config: SlackSocketAdapterConfig) {
		super(config);
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackSocketAdapter: handler not set. Call setHandler() before start().");

		await this.initMetadata();
		this.setupEventHandlers();
		await this.socketClient.start();
		this.markStarted();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
	}

	// ==========================================================================
	// Socket Mode event handlers
	// ==========================================================================

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user?: string;
				bot_id?: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Feed pulse before any filtering
			if (this.pulse && (e.user || e.bot_id)) {
				this.pulse.record(e.channel, e.user || e.bot_id!, (e.text || "").length);
			}

			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			// Ignore own messages only
			if (e.user === this.botUserId) {
				ack();
				return;
			}

			const userId = e.user || e.bot_id || "unknown";

			const momEvent: MomEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: userId,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${momEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			if (momEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this);
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			if (this.handler.isRunning(e.channel)) {
				this.handler.handleSteer(momEvent, this);
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering) + ambient engagement
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Feed pulse before any filtering — pulse needs to see everything
			if (this.pulse && (e.user || e.bot_id)) {
				this.pulse.record(e.channel, e.user || e.bot_id!, (e.text || "").length);
			}

			// Ignore own messages only — bots are just participants
			if (e.user === this.botUserId) {
				ack();
				return;
			}
			// Ignore subtypes other than file_share and bot_message
			if (e.subtype !== undefined && e.subtype !== "file_share" && e.subtype !== "bot_message") {
				ack();
				return;
			}
			// Need at least a user or bot_id
			if (!e.user && !e.bot_id) {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const userId = e.user || e.bot_id || "unknown";
			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const momEvent: MomEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: userId,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${momEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			if (isDM) {
				if (momEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this);
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.handler.handleSteer(momEvent, this);
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
				}
			} else {
				// Ambient engagement: non-DM, non-mention message
				this.onAmbientMessage?.(e.channel, momEvent);
			}

			ack();
		});
	}
}
