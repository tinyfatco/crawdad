import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import { TelegramBase, type TelegramBaseConfig } from "./telegram-base.js";

// ============================================================================
// TelegramWebhookAdapter — HTTPS webhook (serverless-friendly)
// ============================================================================

export interface TelegramWebhookAdapterConfig extends TelegramBaseConfig {
	webhookUrl?: string;
	webhookSecret: string;
	/** Skip setWebHook/deleteWebHook calls. Use when webhook URL is managed externally (e.g. CF Worker). */
	skipRegistration?: boolean;
}

export class TelegramWebhookAdapter extends TelegramBase {
	private webhookUrl?: string;
	private webhookSecret: string;
	private skipRegistration: boolean;

	constructor(config: TelegramWebhookAdapterConfig) {
		super(config);
		this.webhookUrl = config.webhookUrl;
		this.webhookSecret = config.webhookSecret;
		this.skipRegistration = config.skipRegistration || !!process.env.MOM_SKIP_WEBHOOK_REGISTRATION;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramWebhookAdapter: handler not set. Call setHandler() before start().");

		const me = await this.bot.getMe();
		log.logInfo(`Telegram bot (webhook): @${me.username} (${me.id})`);

		// Wire up message handler — processUpdate() fires bot.on("message") events
		this.bot.on("message", (msg) => this.handleIncomingMessage(msg));

		// Register webhook with Telegram API (unless managed externally)
		if (!this.skipRegistration) {
			if (!this.webhookUrl) throw new Error("TelegramWebhookAdapter: webhookUrl required when not skipping registration");
			const webhookOpts: { secret_token: string } = {
				secret_token: this.webhookSecret,
			};
			await this.bot.setWebHook(this.webhookUrl, webhookOpts);
			log.logInfo(`Telegram webhook registered: ${this.webhookUrl}`);
		} else {
			log.logInfo("Telegram webhook registration skipped (managed externally)");
		}

		log.logConnected();
	}

	async stop(): Promise<void> {
		// Unregister webhook with Telegram (unless managed externally)
		if (!this.skipRegistration) {
			try {
				await this.bot.deleteWebHook();
				log.logInfo("Telegram webhook deleted");
			} catch (err) {
				log.logWarning("Failed to delete Telegram webhook", err instanceof Error ? err.message : String(err));
			}
		}
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf-8");

			// Verify secret token header
			const secretToken = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
			if (!secretToken || secretToken !== this.webhookSecret) {
				log.logWarning("Telegram webhook secret token verification failed");
				res.writeHead(401);
				res.end("Invalid secret token");
				return;
			}

			let update: object;
			try {
				update = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			const holdConnection = !!process.env.MOM_HOLD_WEBHOOK_CONNECTION;

			if (!holdConnection) {
				// Fire-and-forget (crawdad-cf mode)
				res.writeHead(200);
				res.end();
			}

			log.logInfo(`[telegram:webhook] dispatch: processing update at ${new Date().toISOString()} (hold=${holdConnection})`);
			// Process the update — fires bot.on("message") which calls handleIncomingMessage
			this.bot.processUpdate(update as Parameters<typeof this.bot.processUpdate>[0]);

			if (holdConnection) {
				// Wait for the run to complete before responding (Sprites mode)
				await this.lastRunDone;
				res.writeHead(200);
				res.end();
				log.logInfo(`[telegram:webhook] held connection released`);
			}
		});
	}
}
