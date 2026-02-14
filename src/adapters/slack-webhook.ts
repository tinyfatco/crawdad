import { createHmac, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { SlackBase, type SlackBaseConfig } from "./slack-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// SlackWebhookAdapter — HTTP Events API (serverless-friendly)
// ============================================================================

export interface SlackWebhookAdapterConfig extends SlackBaseConfig {
	signingSecret: string;
	port: number;
}

export class SlackWebhookAdapter extends SlackBase {
	private signingSecret: string;
	private port: number;
	private server: Server | null = null;

	constructor(config: SlackWebhookAdapterConfig) {
		super(config);
		this.signingSecret = config.signingSecret;
		this.port = config.port;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackWebhookAdapter: handler not set. Call setHandler() before start().");

		this.server = createServer((req, res) => this.handleRequest(req, res));

		await new Promise<void>((resolve) => {
			this.server!.listen(this.port, () => {
				log.logInfo(`Slack webhook server listening on port ${this.port}`);
				resolve();
			});
		});

		await this.initMetadata();

		this.markStarted();
	}

	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
			this.server = null;
		}
	}

	// ==========================================================================
	// HTTP request handling
	// ==========================================================================

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "POST" || req.url !== "/slack/events") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

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

			this.dispatch(payload, res);
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

	private dispatch(payload: SlackEventPayload, res: ServerResponse): void {
		// URL verification challenge
		if (payload.type === "url_verification") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ challenge: payload.challenge }));
			log.logInfo("Slack URL verification challenge passed");
			return;
		}

		// Acknowledge immediately (Slack requires response within 3 seconds)
		res.writeHead(200);
		res.end();

		if (payload.type !== "event_callback" || !payload.event) {
			return;
		}

		const event = payload.event;

		// Ignore bot messages and messages without users
		if (event.bot_id || !event.user || event.user === this.botUserId) return;
		// Ignore subtypes other than file_share
		if (event.subtype !== undefined && event.subtype !== "file_share") return;

		if (event.type === "app_mention") {
			this.handleAppMention(event);
		} else if (event.type === "message") {
			this.handleMessage(event);
		}
	}

	private handleAppMention(event: SlackEventInner): void {
		if (event.channel.startsWith("D")) return;

		const momEvent: MomEvent = {
			type: "mention",
			channel: event.channel,
			ts: event.ts,
			user: event.user!,
			text: (event.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (this.startupTs && event.ts < this.startupTs) {
			log.logInfo(
				`[${event.channel}] Logged old message (pre-startup), not triggering: ${momEvent.text.substring(0, 30)}`,
			);
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
			this.postMessage(event.channel, "_Already working. Say `@mom stop` to cancel._");
		} else {
			this.getQueue(event.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
		}
	}

	private handleMessage(event: SlackEventInner): void {
		if (!event.text && (!event.files || event.files.length === 0)) return;

		const isDM = event.channel_type === "im";
		const isBotMention = event.text?.includes(`<@${this.botUserId}>`);

		// Skip channel messages that are @mentions (handled by app_mention)
		if (!isDM && isBotMention) return;

		const momEvent: MomEvent = {
			type: isDM ? "dm" : "mention",
			channel: event.channel,
			ts: event.ts,
			user: event.user!,
			text: (event.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (this.startupTs && event.ts < this.startupTs) {
			log.logInfo(`[${event.channel}] Skipping old message (pre-startup): ${momEvent.text.substring(0, 30)}`);
			return;
		}

		if (isDM) {
			if (momEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(event.channel)) {
					this.handler.handleStop(event.channel, this);
				} else {
					this.postMessage(event.channel, "_Nothing running_");
				}
				return;
			}

			if (this.handler.isRunning(event.channel)) {
				this.postMessage(event.channel, "_Already working. Say `stop` to cancel._");
			} else {
				this.getQueue(event.channel).enqueue(() => this.handler.handleEvent(momEvent, this));
			}
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
