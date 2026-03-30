import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { SlackBase, type SlackBaseConfig } from "./slack-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// SlackWebhookAdapter — HTTP Events API (serverless-friendly)
// ============================================================================

export interface SlackWebhookAdapterConfig extends SlackBaseConfig {
	signingSecret: string;
	/** Optional: returns and clears a pending ambient defer signal (Sprites mode). */
	consumeAmbientDefer?: () => { channelId: string; delaySec: number } | null;
}

export class SlackWebhookAdapter extends SlackBase {
	private signingSecret: string;
	consumeAmbientDefer?: () => { channelId: string; delaySec: number } | null;

	constructor(config: SlackWebhookAdapterConfig) {
		super(config);
		this.signingSecret = config.signingSecret;
		this.consumeAmbientDefer = config.consumeAmbientDefer;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackWebhookAdapter: handler not set. Call setHandler() before start().");

		await this.initMetadata();

		this.markStarted();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks);
			const body = rawBody.toString("utf-8");

			// Verify signature
			const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
			const signature = req.headers["x-slack-signature"] as string | undefined;

			if (!timestamp || !signature) {
				res.writeHead(401);
				res.end("Missing signature headers");
				return;
			}

			// Reject requests older than 5 minutes (replay protection)
			const now = Math.floor(Date.now() / 1000);
			if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
				res.writeHead(401);
				res.end("Request too old");
				return;
			}

			if (!this.verifySignature(timestamp, body, signature)) {
				log.logWarning("Slack webhook signature verification failed");
				res.writeHead(401);
				res.end("Invalid signature");
				return;
			}

			let payload: SlackEventPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			this.dispatchEvent(payload, res);
		});
	}

	// ==========================================================================
	// Signature verification
	// ==========================================================================

	private verifySignature(timestamp: string, body: string, expectedSignature: string): boolean {
		const sigBasestring = `v0:${timestamp}:${body}`;
		const hmac = createHmac("sha256", this.signingSecret);
		hmac.update(sigBasestring);
		const computed = `v0=${hmac.digest("hex")}`;

		try {
			return timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSignature));
		} catch {
			return false;
		}
	}

	// ==========================================================================
	// Event dispatch
	// ==========================================================================

	/** Promise that resolves when the last enqueued run completes. Used by hold-connection mode. */
	public lastRunDone: Promise<void> = Promise.resolve();

	private async dispatchEvent(payload: SlackEventPayload, res: ServerResponse): Promise<void> {
		// URL verification challenge
		if (payload.type === "url_verification") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ challenge: payload.challenge }));
			log.logInfo("Slack URL verification challenge passed");
			return;
		}

		const holdConnection = !!process.env.MOM_HOLD_WEBHOOK_CONNECTION;

		if (!holdConnection) {
			// Fire-and-forget (crawdad-cf mode)
			res.writeHead(200);
			res.end();
		}

		if (payload.type !== "event_callback" || !payload.event) {
			if (holdConnection) { res.writeHead(200); res.end(); }
			return;
		}

		const event = payload.event;

		// Feed pulse on every message (before any filtering) — pulse needs to see everything
		if (this.pulse && event.ts && (event.user || event.bot_id)) {
			this.pulse.record(event.channel, event.user || event.bot_id!, (event.text || "").length, event.text);
		}

		// Ignore own messages only — bots are just participants
		if (event.user === this.botUserId) {
			if (holdConnection) { res.writeHead(200); res.end(); }
			return;
		}
		// Ignore subtypes other than file_share and bot_message
		if (event.subtype !== undefined && event.subtype !== "file_share" && event.subtype !== "bot_message") {
			if (holdConnection) { res.writeHead(200); res.end(); }
			return;
		}
		// Need at least a user or bot_id to attribute the message
		if (!event.user && !event.bot_id) {
			if (holdConnection) { res.writeHead(200); res.end(); }
			return;
		}

		if (event.type === "app_mention") {
			this.handleAppMention(event);
		} else if (event.type === "message") {
			this.handleMessage(event);
		}

		if (holdConnection) {
			await this.lastRunDone;
			// Check for deferred ambient signal (Sprites mode)
			const ambientDefer = this.consumeAmbientDefer?.();
			if (ambientDefer) {
				res.writeHead(200, { "X-Ambient-Defer": `${ambientDefer.channelId}:${ambientDefer.delaySec}` });
			} else {
				res.writeHead(200);
			}
			res.end();
		}
	}

	private handleAppMention(event: SlackEventInner): void {
		if (event.channel.startsWith("D")) return;

		const momEvent: MomEvent = {
			type: "mention",
			channel: event.channel,
			ts: event.ts,
			user: event.user || event.bot_id || "unknown",
			text: (event.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (this.handler.resolvePendingInput(event.channel, momEvent.text)) {
			return;
		}

		if (momEvent.text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(event.channel)) {
				this.handler.handleStop(event.channel, this);
			} else {
				this.postMessage(event.channel, "_Nothing running_");
			}
			return;
		}

		if (this.handler.isRunning(event.channel)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.lastRunDone = this.getQueue(event.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
		}
	}

	private handleMessage(event: SlackEventInner): void {
		if (!event.text && (!event.files || event.files.length === 0)) return;

		const isDM = event.channel_type === "im";
		const isBotMention = event.text?.includes(`<@${this.botUserId}>`);

		// Skip channel messages that are @mentions (handled by app_mention)
		if (!isDM && isBotMention) return;

		const userId = event.user || event.bot_id || "unknown";

		const momEvent: MomEvent = {
			type: isDM ? "dm" : "mention",
			channel: event.channel,
			ts: event.ts,
			user: userId,
			text: (event.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (isDM) {
			if (this.handler.resolvePendingInput(event.channel, momEvent.text)) {
				return;
			}

			if (momEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(event.channel)) {
					this.handler.handleStop(event.channel, this);
				} else {
					this.postMessage(event.channel, "_Nothing running_");
				}
				return;
			}

			if (this.handler.isRunning(event.channel)) {
				this.handler.handleSteer(momEvent, this);
			} else {
				this.lastRunDone = this.getQueue(event.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
			}
		} else {
			// Ambient engagement: non-DM, non-mention message — let the engagement system decide
			this.onAmbientMessage?.(event.channel, momEvent);
		}
	}
}

// ============================================================================
// Slack webhook payload types
// ============================================================================

interface SlackEventPayload {
	type: "url_verification" | "event_callback";
	challenge?: string;
	token?: string;
	event?: SlackEventInner;
}

interface SlackEventInner {
	type: string;
	channel: string;
	channel_type?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	ts: string;
	subtype?: string;
	files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
}
