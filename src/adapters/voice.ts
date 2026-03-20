/**
 * VoiceAdapter — phone call adapter using ElevenLabs STT/TTS.
 *
 * The adapter doesn't know about Twilio. It just runs a WebSocket server
 * on port 8765 that accepts audio streams. The orchestrator (crawdad-cf)
 * handles telephony and pipes audio to/from this server.
 *
 * Audio format: mulaw 8kHz (standard telephony), base64 encoded in JSON frames.
 * The WebSocket protocol matches Twilio Media Streams format for compatibility,
 * but the adapter doesn't depend on Twilio — any source sending the same format works.
 *
 * Each caller utterance (STT end-of-utterance) = one agent run.
 */

import { createServer, type Server } from "http";
import { appendFileSync } from "fs";
import { join } from "path";
import WebSocket, { WebSocketServer } from "ws";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";
import { createSttSession, type SttConfig, type SttSession } from "./voice-stt.js";
import { textToSpeechStreaming, type TtsConfig } from "./voice-tts.js";

// ============================================================================
// Types
// ============================================================================

interface CallSession {
	/** Stream identifier (from the orchestrator) */
	streamSid: string | null;
	/** Caller identifier (phone number or ID) */
	from: string;
	/** Call identifier */
	callSid: string;
	/** The audio WebSocket connection */
	ws: WebSocket;
	/** ElevenLabs STT session */
	sttSession: SttSession | null;
	/** Whether TTS is currently playing */
	ttsPlaying: boolean;
	startedAt: number;
}

export interface VoiceAdapterConfig {
	workingDir: string;
	elevenlabsApiKey: string;
	elevenlabsVoiceId: string;
	elevenlabsModelId?: string;
	/** VAD silence threshold in seconds (default 1.5) */
	vadSilenceThreshold?: number;
	/** Port for the WebSocket server (default 8765) */
	wsPort?: number;
}

// ============================================================================
// VoiceAdapter
// ============================================================================

export class VoiceAdapter implements PlatformAdapter {
	readonly name = "voice";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Voice Call
You are on a live phone call. Keep responses concise and conversational — the caller hears everything you say spoken aloud.
Do not use markdown formatting, links, or code blocks — they don't translate to speech.
Be direct, warm, and natural. Avoid long lists or complex structured output.
If you need to do something that takes time, say "One moment" or "Let me check on that" so the caller knows you're working.`;

	private workingDir: string;
	private handler!: MomHandler;
	private config: VoiceAdapterConfig;
	private ttsConfig: TtsConfig;
	private sttConfig: SttConfig;

	/** Active call sessions */
	private calls = new Map<string, CallSession>();
	/** WebSocket server */
	private wss: WebSocketServer | null = null;
	private wsServer: Server | null = null;

	private channelId = "voice-call";

	constructor(config: VoiceAdapterConfig) {
		this.workingDir = config.workingDir;
		this.config = config;
		this.ttsConfig = {
			apiKey: config.elevenlabsApiKey,
			voiceId: config.elevenlabsVoiceId,
			modelId: config.elevenlabsModelId,
		};
		this.sttConfig = {
			apiKey: config.elevenlabsApiKey,
			vadSilenceThreshold: config.vadSilenceThreshold ?? 1.5,
		};
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.handler) throw new Error("VoiceAdapter: handler not set");

		// Check if main.ts already bound port 8765 (early server for cold-start readiness)
		const early = (globalThis as any).__voiceEarlyServer as {
			server: Server; wss: WebSocketServer; pendingConnections: WebSocket[];
		} | undefined;

		if (early) {
			// Take over the early server
			this.wsServer = early.server;
			this.wss = early.wss;

			// Wire up new connections
			this.wss.on("connection", (ws) => {
				this.handleConnection(ws);
			});

			// Handle any connections that arrived before we were ready
			for (const ws of early.pendingConnections) {
				if (ws.readyState === WebSocket.OPEN) {
					log.logInfo("[voice] Adopting early connection");
					this.handleConnection(ws);
				}
			}
			early.pendingConnections.length = 0;
			delete (globalThis as any).__voiceEarlyServer;

			log.logInfo("[voice] Took over early WebSocket server on port 8765");
		} else {
			// No early server — start our own
			const port = this.config.wsPort || 8765;
			this.wsServer = createServer();
			this.wss = new WebSocketServer({ server: this.wsServer });

			this.wss.on("connection", (ws) => {
				this.handleConnection(ws);
			});

			await new Promise<void>((resolve) => {
				this.wsServer!.listen(port, () => {
					log.logInfo(`[voice] WebSocket server listening on port ${port}`);
					resolve();
				});
			});
		}

		log.logInfo("Voice adapter ready");
	}

	async stop(): Promise<void> {
		for (const [, call] of this.calls) {
			call.sttSession?.close();
			call.ws?.close();
		}
		this.calls.clear();

		if (this.wss) { this.wss.close(); this.wss = null; }
		if (this.wsServer) { this.wsServer.close(); this.wsServer = null; }
	}

	// ==========================================================================
	// WebSocket connection handler
	// ==========================================================================

	private handleConnection(ws: WebSocket): void {
		log.logInfo("[voice] New audio stream connection");

		let session: CallSession | null = null;

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());

				switch (msg.event) {
					case "connected":
						log.logInfo("[voice] Stream connected");
						break;

					case "start": {
						const streamSid = msg.start?.streamSid || msg.streamSid || null;
						const callSid = msg.start?.customParameters?.callSid || "unknown";
						const from = msg.start?.customParameters?.from || "unknown";
						log.logInfo(`[voice] Stream started: streamSid=${streamSid} callSid=${callSid} from=${from}`);

						session = {
							streamSid,
							from,
							callSid,
							ws,
							sttSession: null,
							ttsPlaying: false,
							startedAt: Date.now(),
						};
						this.calls.set(callSid, session);
						this.startStt(session);
						break;
					}

					case "media":
						// Forward audio to STT
						if (session?.sttSession) {
							session.sttSession.sendAudio(msg.media.payload);
						}
						break;

					case "mark":
						if (session) session.ttsPlaying = false;
						break;

					case "stop":
						log.logInfo(`[voice] Stream stopped: ${session?.streamSid}`);
						if (session) {
							session.sttSession?.close();
							this.calls.delete(session.callSid);
						}
						break;
				}
			} catch (err) {
				log.logWarning(`[voice] Failed to parse message: ${err}`);
			}
		});

		ws.on("close", () => {
			log.logInfo("[voice] Stream WebSocket closed");
			if (session) {
				session.sttSession?.close();
				this.calls.delete(session.callSid);
			}
		});

		ws.on("error", (err) => {
			log.logWarning(`[voice] Stream WebSocket error: ${err.message}`);
		});
	}

	// ==========================================================================
	// STT
	// ==========================================================================

	private startStt(session: CallSession): void {
		log.logInfo(`[voice] Starting STT for ${session.callSid}`);

		session.sttSession = createSttSession(
			this.sttConfig,
			(text: string) => this.handleUtterance(session, text),
			undefined,
			(err: Error) => log.logWarning(`[voice] STT error: ${err.message}`),
		);
	}

	private handleUtterance(session: CallSession, text: string): void {
		if (!text.trim()) return;
		log.logInfo(`[voice] Utterance from ${session.from}: "${text}"`);

		const event: MomEvent = {
			type: "dm",
			channel: this.channelId,
			ts: String(Date.now()),
			user: session.from,
			text,
		};

		if (this.handler.isRunning(this.channelId)) {
			this.handler.handleSteer(event, this);
			return;
		}

		this.handler.handleEvent(event, this).catch((err) => {
			log.logWarning(`[voice] handleEvent error: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	// ==========================================================================
	// TTS — send audio back through the WebSocket
	// ==========================================================================

	private async speakToCall(session: CallSession, text: string): Promise<void> {
		if (session.ws.readyState !== WebSocket.OPEN || !session.streamSid) return;

		session.ttsPlaying = true;
		const sid = session.streamSid;
		let chunkCount = 0;

		try {
			await textToSpeechStreaming(text, this.ttsConfig, (base64Audio: string) => {
				if (session.ws.readyState !== WebSocket.OPEN) return;
				session.ws.send(JSON.stringify({
					event: "media",
					streamSid: sid,
					media: { payload: base64Audio },
				}));
				chunkCount++;
			});

			if (session.ws.readyState === WebSocket.OPEN) {
				session.ws.send(JSON.stringify({
					event: "mark",
					streamSid: sid,
					mark: { name: `tts-${Date.now()}` },
				}));
			}

			log.logInfo(`[voice] TTS sent ${chunkCount} chunks`);
		} catch (err) {
			log.logWarning(`[voice] TTS error: ${err instanceof Error ? err.message : String(err)}`);
			session.ttsPlaying = false;
		}
	}

	// ==========================================================================
	// PlatformAdapter interface
	// ==========================================================================

	// No dispatch — we don't receive HTTP webhooks, just WebSocket audio
	dispatch = undefined;

	async postMessage(_channel: string, text: string): Promise<string> {
		const session = this.getActiveCall();
		if (session) await this.speakToCall(session, text);
		return String(Date.now());
	}

	async updateMessage(): Promise<void> {}
	async deleteMessage(): Promise<void> {}
	async postInThread(): Promise<string> { return String(Date.now()); }
	async uploadFile(): Promise<void> {}

	logToFile(entry: object): void {
		try {
			appendFileSync(join(this.workingDir, "log.jsonl"), JSON.stringify({ ...entry, adapter: "voice" }) + "\n");
		} catch { /* ignore */ }
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({ type: "bot_response", channel, text: text.substring(0, 500), ts, timestamp: new Date().toISOString() });
	}

	private users = new Map<string, UserInfo>();

	getUser(userId: string): UserInfo | undefined {
		if (!this.users.has(userId)) {
			this.users.set(userId, { id: userId, userName: userId, displayName: userId });
		}
		return this.users.get(userId);
	}

	getChannel(): ChannelInfo | undefined {
		return { id: this.channelId, name: "phone" };
	}

	getAllUsers(): UserInfo[] { return Array.from(this.users.values()); }
	getAllChannels(): ChannelInfo[] { return [{ id: this.channelId, name: "phone" }]; }

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		const session = this.getActiveCall();

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: event.user,
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: "phone",
			channels: this.getAllChannels(),
			users: this.getAllUsers(),

			respond: async (_text: string, _shouldLog = true) => {
				// Don't TTS interim responses (thinking, tool status, etc.)
				// Only sendFinalResponse gets spoken aloud
			},

			sendFinalResponse: async (text: string) => {
				if (!text.trim()) return;
				if (session) await this.speakToCall(session, text);
				this.logBotResponse(event.channel, text, String(Date.now()));
			},

			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			restartWorking: async () => {},
		};
	}

	private eventQueue: MomEvent[] = [];

	enqueueEvent(event: MomEvent): boolean {
		this.eventQueue.push(event);
		setTimeout(() => this.processEventQueue(), 0);
		return true;
	}

	private async processEventQueue(): Promise<void> {
		while (this.eventQueue.length > 0) {
			const event = this.eventQueue.shift()!;
			if (!this.handler.isRunning(this.channelId)) {
				try { await this.handler.handleEvent(event, this); }
				catch (err) { log.logWarning(`[voice] Event error: ${err instanceof Error ? err.message : String(err)}`); }
			}
		}
	}

	private getActiveCall(): CallSession | null {
		for (const [, session] of this.calls) {
			if (session.ws.readyState === WebSocket.OPEN) return session;
		}
		return null;
	}
}
