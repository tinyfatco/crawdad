import * as log from "../log.js";
import { DiscordBase, type DiscordBaseConfig, type DiscordMessage } from "./discord-base.js";

// ============================================================================
// DiscordGatewayAdapter — WebSocket Gateway connection
//
// Connects to Discord's Gateway WebSocket to receive MESSAGE_CREATE events.
// The bot appears online when the container is awake. Messages received
// via @mention or DM are routed through the standard handler pipeline.
//
// Uses Node 22 built-in WebSocket — zero dependencies.
// ============================================================================

// Discord Gateway opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Gateway intents
const INTENT_GUILD_MESSAGES = 1 << 9;       // MESSAGE_CREATE in guilds
const INTENT_DIRECT_MESSAGES = 1 << 12;     // MESSAGE_CREATE in DMs
const INTENT_MESSAGE_CONTENT = 1 << 15;     // Read message.content (privileged)

export interface DiscordGatewayAdapterConfig extends DiscordBaseConfig {
	/** Bot user ID — if known, used to filter self-mentions. Resolved on READY if not provided. */
	botUserId?: string;
}

export class DiscordGatewayAdapter extends DiscordBase {
	private ws: WebSocket | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private heartbeatIntervalMs = 0;
	private lastSequence: number | null = null;
	private sessionId: string | null = null;
	private resumeGatewayUrl: string | null = null;
	private botUserId: string | null;
	private shouldReconnect = true;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;

	constructor(config: DiscordGatewayAdapterConfig) {
		super(config);
		this.botUserId = config.botUserId || null;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("DiscordGatewayAdapter: handler not set. Call setHandler() before start().");

		this.shouldReconnect = true;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.shouldReconnect = false;
		this.clearHeartbeat();
		if (this.ws) {
			this.ws.close(1000, "Shutting down");
			this.ws = null;
		}
	}

	// ==========================================================================
	// Gateway connection lifecycle
	// ==========================================================================

	private async connect(resume = false): Promise<void> {
		const gatewayUrl = resume && this.resumeGatewayUrl
			? this.resumeGatewayUrl
			: "wss://gateway.discord.gg";

		const url = `${gatewayUrl}/?v=10&encoding=json`;
		log.logInfo(`[discord-gw] Connecting to ${resume ? "resume" : "new"} session: ${gatewayUrl}`);

		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url);
			this.ws = ws;

			let resolved = false;

			ws.addEventListener("open", () => {
				log.logInfo("[discord-gw] WebSocket connected");
			});

			ws.addEventListener("message", (event) => {
				let payload: GatewayPayload;
				try {
					payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
				} catch {
					log.logWarning("[discord-gw] Failed to parse gateway message");
					return;
				}

				// Track sequence number for heartbeats and resume
				if (payload.s !== null && payload.s !== undefined) {
					this.lastSequence = payload.s;
				}

				this.handleGatewayPayload(payload, resume).then(() => {
					// Resolve the connect promise once we get READY or RESUMED
					if (!resolved && (payload.t === "READY" || payload.t === "RESUMED")) {
						resolved = true;
						this.reconnectAttempts = 0;
						resolve();
					}
				}).catch((err) => {
					log.logWarning("[discord-gw] Error handling payload", err instanceof Error ? err.message : String(err));
				});
			});

			ws.addEventListener("close", (event) => {
				log.logInfo(`[discord-gw] WebSocket closed: code=${event.code} reason=${event.reason}`);
				this.clearHeartbeat();
				this.ws = null;

				if (!resolved) {
					resolved = true;
					reject(new Error(`WebSocket closed before ready: ${event.code}`));
					return;
				}

				if (this.shouldReconnect) {
					this.scheduleReconnect();
				}
			});

			ws.addEventListener("error", (event) => {
				log.logWarning("[discord-gw] WebSocket error", String(event));
				if (!resolved) {
					resolved = true;
					reject(new Error("WebSocket connection error"));
				}
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			log.logWarning(`[discord-gw] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
			return;
		}

		const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
		this.reconnectAttempts++;
		log.logInfo(`[discord-gw] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

		setTimeout(() => {
			if (!this.shouldReconnect) return;
			// Try to resume if we have a session
			const canResume = !!(this.sessionId && this.resumeGatewayUrl);
			this.connect(canResume).catch((err) => {
				log.logWarning("[discord-gw] Reconnect failed", err instanceof Error ? err.message : String(err));
				if (this.shouldReconnect) {
					this.scheduleReconnect();
				}
			});
		}, delay);
	}

	// ==========================================================================
	// Gateway payload handling
	// ==========================================================================

	private async handleGatewayPayload(payload: GatewayPayload, isResuming: boolean): Promise<void> {
		switch (payload.op) {
			case OP_HELLO: {
				// Start heartbeating
				this.heartbeatIntervalMs = payload.d.heartbeat_interval;
				this.startHeartbeat();

				// Send IDENTIFY or RESUME
				if (isResuming && this.sessionId) {
					this.sendResume();
				} else {
					this.sendIdentify();
				}
				break;
			}

			case OP_HEARTBEAT_ACK: {
				// Server acknowledged our heartbeat — connection is healthy
				break;
			}

			case OP_HEARTBEAT: {
				// Server is requesting an immediate heartbeat
				this.sendHeartbeat();
				break;
			}

			case OP_RECONNECT: {
				// Server wants us to reconnect and resume
				log.logInfo("[discord-gw] Server requested reconnect");
				this.ws?.close(4000, "Reconnecting");
				break;
			}

			case OP_INVALID_SESSION: {
				// Session is invalid — can we resume?
				const resumable = payload.d;
				log.logInfo(`[discord-gw] Invalid session, resumable=${resumable}`);
				if (!resumable) {
					// Clear session — next connect will be a fresh IDENTIFY
					this.sessionId = null;
					this.lastSequence = null;
				}
				// Wait a bit then reconnect (Discord recommends 1-5s)
				await new Promise((r) => setTimeout(r, 2000));
				this.ws?.close(4000, "Invalid session");
				break;
			}

			case OP_DISPATCH: {
				await this.handleDispatch(payload.t!, payload.d);
				break;
			}
		}
	}

	private async handleDispatch(eventName: string, data: any): Promise<void> {
		switch (eventName) {
			case "READY": {
				this.sessionId = data.session_id;
				this.resumeGatewayUrl = data.resume_gateway_url;
				this.botUserId = data.user?.id || this.botUserId;
				log.logInfo(`[discord-gw] READY: session=${this.sessionId} bot=${data.user?.username}#${data.user?.discriminator}`);
				log.logConnected();
				break;
			}

			case "RESUMED": {
				log.logInfo("[discord-gw] Session resumed successfully");
				break;
			}

			case "MESSAGE_CREATE": {
				this.handleMessageCreate(data as DiscordMessage);
				break;
			}

			case "GUILD_CREATE": {
				// Populate channel metadata from guild data
				if (data.channels) {
					for (const ch of data.channels) {
						if (ch.id && ch.name) {
							this.channels.set(ch.id, { id: ch.id, name: ch.name });
						}
					}
				}
				if (data.members) {
					for (const m of data.members) {
						if (m.user && m.user.id) {
							this.users.set(m.user.id, {
								id: m.user.id,
								userName: m.user.username,
								displayName: m.user.global_name || m.user.username,
							});
						}
					}
				}
				log.logInfo(`[discord-gw] Guild loaded: ${data.name} (${data.channels?.length || 0} channels, ${data.members?.length || 0} members)`);
				break;
			}
		}
	}

	private handleMessageCreate(msg: DiscordMessage): void {
		// Ignore our own messages
		if (this.botUserId && msg.author.id === this.botUserId) return;

		// In guilds, only respond to @mentions of the bot or DMs
		if (msg.guild_id) {
			const isMentioned = msg.mentions?.some((u) => u.id === this.botUserId)
				|| msg.mentioned_users?.some((u) => u.id === this.botUserId);
			if (!isMentioned) return;
		}

		// Delegate to shared base class handler
		this.handleIncomingMessage(msg);
	}

	// ==========================================================================
	// Heartbeat
	// ==========================================================================

	private startHeartbeat(): void {
		this.clearHeartbeat();

		// Send first heartbeat after a random jitter (Discord spec)
		const jitter = Math.random() * this.heartbeatIntervalMs;
		setTimeout(() => {
			this.sendHeartbeat();
			// Then send on the regular interval
			this.heartbeatInterval = setInterval(() => {
				this.sendHeartbeat();
			}, this.heartbeatIntervalMs);
		}, jitter);
	}

	private sendHeartbeat(): void {
		this.send({ op: OP_HEARTBEAT, d: this.lastSequence });
	}

	private clearHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	// ==========================================================================
	// Gateway commands
	// ==========================================================================

	private sendIdentify(): void {
		this.send({
			op: OP_IDENTIFY,
			d: {
				token: this.botToken,
				intents: INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT,
				properties: {
					os: "linux",
					browser: "troublemaker",
					device: "troublemaker",
				},
			},
		});
		log.logInfo("[discord-gw] Sent IDENTIFY");
	}

	private sendResume(): void {
		this.send({
			op: OP_RESUME,
			d: {
				token: this.botToken,
				session_id: this.sessionId,
				seq: this.lastSequence,
			},
		});
		log.logInfo(`[discord-gw] Sent RESUME (session=${this.sessionId}, seq=${this.lastSequence})`);
	}

	private send(data: object): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		}
	}
}

// ============================================================================
// Gateway payload types
// ============================================================================

interface GatewayPayload {
	op: number;
	d: any;
	s?: number | null;
	t?: string | null;
}
