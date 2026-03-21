import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import { stripDiscordMentions } from "./discord-format.js";
import { DiscordBase, type DiscordBaseConfig } from "./discord-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// DiscordWebhookAdapter — HTTP Interactions endpoint
//
// Receives Discord Interaction payloads (slash commands) via HTTP POST.
// Responds with type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) immediately,
// then the agent processes and responds via follow-up REST calls.
// ============================================================================

export interface DiscordWebhookAdapterConfig extends DiscordBaseConfig {
	/** Ed25519 public key for verifying interaction signatures */
	publicKey: string;
}

export class DiscordWebhookAdapter extends DiscordBase {
	private publicKey: string;
	private cryptoKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> | null = null;

	constructor(config: DiscordWebhookAdapterConfig) {
		super(config);
		this.publicKey = config.publicKey;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("DiscordWebhookAdapter: handler not set. Call setHandler() before start().");

		// Import the Ed25519 public key for signature verification
		this.cryptoKey = await crypto.subtle.importKey(
			"raw",
			hexToUint8Array(this.publicKey),
			{ name: "Ed25519" },
			false,
			["verify"],
		);

		log.logInfo(`Discord bot (webhook): app=${this.applicationId}`);
		log.logConnected();
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
		req.on("end", async () => {
			const rawBody = Buffer.concat(chunks).toString("utf-8");
			const url = req.url || "";

			// Route: /discord/messages — Gateway relay MESSAGE_CREATE (trusted, no sig verification)
			if (url.includes("/discord/messages")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));

				try {
					const payload = JSON.parse(rawBody);
					await this.handleGatewayMessage(payload);
				} catch (err) {
					log.logWarning("[discord] handleGatewayMessage error", err instanceof Error ? err.message : String(err));
				}
				return;
			}

			// Route: /discord/interactions — standard Interactions webhook
			const signature = req.headers["x-signature-ed25519"] as string | undefined;
			const timestamp = req.headers["x-signature-timestamp"] as string | undefined;

			if (!signature || !timestamp) {
				res.writeHead(401);
				res.end("Missing signature headers");
				return;
			}

			const isValid = await this.verifySignature(timestamp, rawBody, signature);
			if (!isValid) {
				log.logWarning("Discord interaction signature verification failed");
				res.writeHead(401);
				res.end("Invalid signature");
				return;
			}

			let interaction: DiscordInteraction;
			try {
				interaction = JSON.parse(rawBody);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			// Handle PING (type 1) — Discord verification handshake
			if (interaction.type === 1) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ type: 1 }));
				log.logInfo("Discord PING verification passed");
				return;
			}

			// Handle APPLICATION_COMMAND (type 2) — slash commands
			if (interaction.type === 2) {
				// Respond immediately with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5)
				// Discord shows "Bot is thinking..." in the channel
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ type: 5 }));

				// Process the interaction asynchronously
				this.handleApplicationCommand(interaction).catch((err) => {
					log.logWarning("[discord] handleApplicationCommand error", err instanceof Error ? err.message : String(err));
				});
				return;
			}

			// Unknown interaction type — ack and ignore
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ type: 1 }));
		});
	}

	// ==========================================================================
	// Gateway relay message handler (MESSAGE_CREATE from discord-gateway)
	// ==========================================================================

	private async handleGatewayMessage(payload: {
		type: string;
		channelId: string;
		guildId: string | null;
		author: { id: string; username: string; discriminator?: string };
		content: string;
		messageId: string;
		isDM: boolean;
		timestamp: string;
	}): Promise<void> {
		const { channelId, author, content, messageId, isDM } = payload;

		if (!content.trim()) return;

		log.logInfo(`[discord] Gateway message: ${isDM ? "DM" : "@mention"} from ${author.username}: ${content.substring(0, 80)}`);

		// Track user
		this.users.set(author.id, { id: author.id, userName: author.username, displayName: author.username });

		// Track channel
		this.channels.set(channelId, { id: channelId, name: channelId });

		const momEvent: MomEvent = {
			type: isDM ? "dm" : "mention",
			channel: channelId,
			ts: messageId,
			user: author.id,
			text: stripDiscordMentions(content),
		};

		// Log user message
		this.logToFile({
			date: new Date().toISOString(),
			ts: messageId,
			channel: `discord:${isDM ? "DM" : channelId}`,
			channelId,
			user: author.id,
			userName: author.username,
			text: content,
			attachments: [],
			isBot: false,
		});

		// Check for stop
		if (content.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(channelId)) {
				this.handler.handleStop(channelId, this);
			}
			return;
		}

		// Steer into active run or start new one
		if (this.handler.isRunning(channelId)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.enqueueWork(channelId, () => this.handler.handleEvent(momEvent, this));
		}
	}

	// ==========================================================================
	// Signature verification (Ed25519)
	// ==========================================================================

	private async verifySignature(timestamp: string, body: string, signature: string): Promise<boolean> {
		if (!this.cryptoKey) return false;

		try {
			const message = new TextEncoder().encode(timestamp + body);
			const sig = hexToUint8Array(signature);

			return await crypto.subtle.verify(
				"Ed25519",
				this.cryptoKey,
				sig,
				message,
			);
		} catch (err) {
			log.logWarning("[discord] Signature verification error", err instanceof Error ? err.message : String(err));
			return false;
		}
	}

	// ==========================================================================
	// Application command handler
	// ==========================================================================

	private async handleApplicationCommand(interaction: DiscordInteraction): Promise<void> {
		const channelId = interaction.channel_id;
		if (!channelId) {
			log.logWarning("[discord] No channel_id in interaction");
			return;
		}

		// Extract user info
		const discordUser = interaction.member?.user || interaction.user;
		if (!discordUser) {
			log.logWarning("[discord] No user in interaction");
			return;
		}

		const userId = discordUser.id;
		const userName = discordUser.username;
		const displayName = discordUser.global_name || discordUser.username;

		// Track user
		this.users.set(userId, { id: userId, userName, displayName });

		// Track channel
		const channelName = interaction.channel?.name || channelId;
		this.channels.set(channelId, { id: channelId, name: channelName });

		// Extract message text from command options
		// The slash command has a single "message" option with the freeform text
		let text = "";
		const options = interaction.data?.options;
		if (options) {
			for (const opt of options) {
				if (opt.name === "message" && typeof opt.value === "string") {
					text = opt.value;
				}
			}
		}

		if (!text.trim()) {
			// No message — edit the deferred response to say so
			await this.editInteractionResponse(interaction.token, "_No message provided_");
			return;
		}

		const momEvent: MomEvent = {
			type: interaction.guild_id ? "mention" : "dm",
			channel: channelId,
			ts: interaction.id,
			user: userId,
			text: stripDiscordMentions(text),
		};

		// Attach interaction token to event for context creation
		(momEvent as any)._interactionToken = interaction.token;

		// Log user message
		this.logToFile({
			date: new Date().toISOString(),
			ts: interaction.id,
			channel: `discord:#${channelName}`,
			channelId,
			user: userId,
			userName,
			displayName,
			text,
			attachments: [],
			isBot: false,
		});

		// Check for stop
		if (text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(channelId)) {
				this.handler.handleStop(channelId, this);
			} else {
				await this.editInteractionResponse(interaction.token, "_Nothing running_");
			}
			return;
		}

		// Steer into active run or start new one
		if (this.handler.isRunning(channelId)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.enqueueWork(channelId, () => this.handler.handleEvent(momEvent, this));
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function hexToUint8Array(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

// ============================================================================
// Discord Interaction types (minimal, just what we need)
// ============================================================================

interface DiscordInteraction {
	id: string;
	type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
	token: string;
	application_id: string;
	guild_id?: string;
	channel_id?: string;
	channel?: { id: string; name?: string };
	member?: {
		user: DiscordUser;
	};
	user?: DiscordUser; // Present in DMs (no guild)
	data?: {
		id: string;
		name: string;
		options?: Array<{
			name: string;
			type: number;
			value: string | number | boolean;
		}>;
	};
}

interface DiscordUser {
	id: string;
	username: string;
	global_name?: string;
	discriminator?: string;
}
