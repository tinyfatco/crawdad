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
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const momEvent: MomEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
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
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
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

			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

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
				user: e.user,
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
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
				}
			}

			ack();
		});
	}
}
