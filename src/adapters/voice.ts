/**
 * VoiceAdapter — phone call adapter using Twilio + ElevenLabs.
 *
 * Telephony: Twilio Programmable Voice + bidirectional Media Streams
 * STT: ElevenLabs realtime (VAD-based end-of-utterance)
 * TTS: ElevenLabs streaming WebSocket (mulaw 8kHz output)
 *
 * Each caller utterance = one agent run. The call session stays open between runs.
 * The agent sees text in, produces text out — same as any other adapter.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
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
	callSid: string;
	streamSid: string | null;
	from: string;
	to: string;
	status: "ringing" | "connected" | "ended";
	/** Twilio Media Stream WebSocket (bidirectional audio) */
	mediaWs: WebSocket | null;
	/** ElevenLabs STT session */
	sttSession: SttSession | null;
	/** Whether TTS is currently playing (for barge-in) */
	ttsPlaying: boolean;
	/** Timestamp of call start */
	startedAt: number;
}

export interface VoiceAdapterConfig {
	workingDir: string;
	twilioAccountSid: string;
	twilioAuthToken: string;
	twilioPhoneNumber: string;
	elevenlabsApiKey: string;
	elevenlabsVoiceId: string;
	elevenlabsModelId?: string;
	/** VAD silence threshold in seconds (default 1.5) */
	vadSilenceThreshold?: number;
	/** Port for the Media Stream WebSocket server (default 8765) */
	mediaWsPort?: number;
	/** Agent ID — used to construct the Media Stream WebSocket URL via crawdad-cf */
	agentId?: string;
	/** Base URL for the WebSocket stream (default: wss://crawdad.tinyfat.com) */
	streamBaseUrl?: string;
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

	/** Active call sessions by callSid */
	private calls = new Map<string, CallSession>();
	/** WebSocket server for Twilio Media Streams */
	private wss: WebSocketServer | null = null;
	private wsServer: Server | null = null;

	/** Channel ID for voice calls (stable, used for awareness) */
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

		// Start WebSocket server for Twilio Media Streams
		const port = this.config.mediaWsPort || 8765;
		this.wsServer = createServer();
		this.wss = new WebSocketServer({ server: this.wsServer });

		this.wss.on("connection", (ws, req) => {
			this.handleMediaStreamConnection(ws, req);
		});

		await new Promise<void>((resolve) => {
			this.wsServer!.listen(port, () => {
				log.logInfo(`[voice] Media Stream WebSocket server listening on port ${port}`);
				resolve();
			});
		});

		log.logInfo("Voice adapter ready");
	}

	async stop(): Promise<void> {
		// Close all active calls
		for (const [, call] of this.calls) {
			call.sttSession?.close();
			call.mediaWs?.close();
		}
		this.calls.clear();

		if (this.wss) {
			this.wss.close();
			this.wss = null;
		}
		if (this.wsServer) {
			this.wsServer.close();
			this.wsServer = null;
		}
	}

	// ==========================================================================
	// HTTP dispatch — receives Twilio webhooks via Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			this.handleTwilioWebhook(body, res);
		});
	}

	private handleTwilioWebhook(body: string, res: ServerResponse): void {
		// Parse URL-encoded body from Twilio
		const params = new URLSearchParams(body);
		const callSid = params.get("CallSid") || "";
		const callStatus = params.get("CallStatus") || "";
		const from = params.get("From") || "";
		const to = params.get("To") || "";

		log.logInfo(`[voice] Twilio webhook: CallSid=${callSid} Status=${callStatus} From=${from}`);

		if (callStatus === "ringing" || !callStatus) {
			// Incoming call — answer with TwiML that opens a bidirectional Media Stream
			this.handleIncomingCall(callSid, from, to, res);
		} else if (callStatus === "in-progress") {
			// Call connected — already handled by Media Stream
			res.writeHead(200, { "Content-Type": "text/xml" });
			res.end("<Response></Response>");
		} else if (callStatus === "completed" || callStatus === "failed" || callStatus === "busy" || callStatus === "no-answer") {
			this.handleCallEnded(callSid, callStatus);
			res.writeHead(200, { "Content-Type": "text/xml" });
			res.end("<Response></Response>");
		} else {
			res.writeHead(200, { "Content-Type": "text/xml" });
			res.end("<Response></Response>");
		}
	}

	private handleIncomingCall(callSid: string, from: string, to: string, res: ServerResponse): void {
		log.logInfo(`[voice] Incoming call from ${from} (CallSid: ${callSid})`);

		// Create call session
		const session: CallSession = {
			callSid,
			streamSid: null,
			from,
			to,
			status: "connected",
			mediaWs: null,
			sttSession: null,
			ttsPlaying: false,
			startedAt: Date.now(),
		};
		this.calls.set(callSid, session);

		// Build the WebSocket URL for Twilio Media Streams.
		// In production via crawdad-cf: wss://crawdad.tinyfat.com/agents/{agentId}/voice/stream
		// Locally: ws://localhost:8765
		const streamBase = this.config.streamBaseUrl || "wss://crawdad.tinyfat.com";
		const agentId = this.config.agentId || "unknown";
		const streamUrl = agentId !== "unknown"
			? `${streamBase}/agents/${agentId}/voice/stream`
			: `ws://localhost:${this.config.mediaWsPort || 8765}`;

		// Respond with TwiML that opens a bidirectional Media Stream.
		// The <Connect><Stream> opens a WS to our server.
		// We pass the callSid as a custom parameter so we can correlate.
		const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
	<Connect>
		<Stream url="${streamUrl}" name="audio-stream">
			<Parameter name="callSid" value="${callSid}" />
		</Stream>
	</Connect>
</Response>`;

		res.writeHead(200, { "Content-Type": "text/xml" });
		res.end(twiml);
	}

	private handleCallEnded(callSid: string, reason: string): void {
		const session = this.calls.get(callSid);
		if (session) {
			log.logInfo(`[voice] Call ended: ${callSid} (${reason})`);
			session.status = "ended";
			session.sttSession?.close();
			session.mediaWs?.close();
			this.calls.delete(callSid);
		}
	}

	// ==========================================================================
	// Twilio Media Stream WebSocket handler
	// ==========================================================================

	private handleMediaStreamConnection(ws: WebSocket, _req: IncomingMessage): void {
		log.logInfo("[voice] New Media Stream WebSocket connection");

		let callSid: string | null = null;
		let streamSid: string | null = null;
		let session: CallSession | null = null;

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());

				switch (msg.event) {
					case "connected":
						log.logInfo("[voice] Media Stream connected");
						break;

					case "start":
						streamSid = msg.start?.streamSid || msg.streamSid;
						callSid = msg.start?.customParameters?.callSid || null;
						log.logInfo(`[voice] Media Stream started: streamSid=${streamSid} callSid=${callSid}`);

						if (callSid) {
							session = this.calls.get(callSid) || null;
							if (session) {
								session.streamSid = streamSid;
								session.mediaWs = ws;
								this.startSttForSession(session);
							} else {
								// Call came in via Media Stream before webhook — create session
								session = {
									callSid,
									streamSid,
									from: "unknown",
									to: this.config.twilioPhoneNumber,
									status: "connected",
									mediaWs: ws,
									sttSession: null,
									ttsPlaying: false,
									startedAt: Date.now(),
								};
								this.calls.set(callSid, session);
								this.startSttForSession(session);
							}
						}
						break;

					case "media":
						// Forward audio to ElevenLabs STT
						if (session?.sttSession) {
							session.sttSession.sendAudio(msg.media.payload);
						}
						break;

					case "mark":
						// TTS playback completed for a mark
						if (session) {
							session.ttsPlaying = false;
						}
						break;

					case "stop":
						log.logInfo(`[voice] Media Stream stopped: ${streamSid}`);
						if (session) {
							session.sttSession?.close();
							session.mediaWs = null;
						}
						break;
				}
			} catch (err) {
				log.logWarning(`[voice] Failed to parse Media Stream message: ${err}`);
			}
		});

		ws.on("close", () => {
			log.logInfo("[voice] Media Stream WebSocket closed");
			if (session) {
				session.sttSession?.close();
				session.mediaWs = null;
			}
		});

		ws.on("error", (err) => {
			log.logWarning(`[voice] Media Stream WebSocket error: ${err.message}`);
		});
	}

	// ==========================================================================
	// STT — speech recognition via ElevenLabs
	// ==========================================================================

	private startSttForSession(session: CallSession): void {
		log.logInfo(`[voice] Starting STT for call ${session.callSid}`);

		const sttSession = createSttSession(
			this.sttConfig,
			// onTranscript — complete utterance, trigger agent run
			(text: string) => {
				this.handleUtterance(session, text);
			},
			// onPartial — interim text (we could use this for "listening" feedback)
			undefined,
			// onError
			(err: Error) => {
				log.logWarning(`[voice] STT error for call ${session.callSid}: ${err.message}`);
			},
		);

		session.sttSession = sttSession;
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

		// If agent is already running, steer the utterance in
		if (this.handler.isRunning(this.channelId)) {
			this.handler.handleSteer(event, this);
			return;
		}

		// Otherwise start a new run
		this.handler.handleEvent(event, this).catch((err) => {
			log.logWarning(`[voice] handleEvent error: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	// ==========================================================================
	// TTS — send audio back to caller via Twilio Media Stream
	// ==========================================================================

	private async speakToCall(session: CallSession, text: string): Promise<void> {
		if (!session.mediaWs || session.mediaWs.readyState !== WebSocket.OPEN) {
			log.logWarning(`[voice] Cannot speak — no active Media Stream for ${session.callSid}`);
			return;
		}
		if (!session.streamSid) {
			log.logWarning(`[voice] Cannot speak — no streamSid for ${session.callSid}`);
			return;
		}

		session.ttsPlaying = true;
		const sid = session.streamSid;
		const ws = session.mediaWs;
		let chunkCount = 0;

		try {
			await textToSpeechStreaming(text, this.ttsConfig, (base64Audio: string) => {
				if (ws.readyState !== WebSocket.OPEN) return;
				// Send audio chunk to Twilio
				ws.send(JSON.stringify({
					event: "media",
					streamSid: sid,
					media: { payload: base64Audio },
				}));
				chunkCount++;
			});

			// Send a mark so we know when playback finishes
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({
					event: "mark",
					streamSid: sid,
					mark: { name: `tts-${Date.now()}` },
				}));
			}

			log.logInfo(`[voice] TTS sent ${chunkCount} chunks for call ${session.callSid}`);
		} catch (err) {
			log.logWarning(`[voice] TTS error: ${err instanceof Error ? err.message : String(err)}`);
			session.ttsPlaying = false;
		}
	}

	/**
	 * Clear audio buffer (barge-in) — stops any currently playing TTS.
	 */
	private clearAudioBuffer(session: CallSession): void {
		if (!session.mediaWs || session.mediaWs.readyState !== WebSocket.OPEN || !session.streamSid) return;
		session.mediaWs.send(JSON.stringify({
			event: "clear",
			streamSid: session.streamSid,
		}));
		session.ttsPlaying = false;
	}

	// ==========================================================================
	// PlatformAdapter — message operations
	// ==========================================================================

	async postMessage(channel: string, text: string): Promise<string> {
		// Find the active call and speak the text
		const session = this.getActiveCall();
		if (session) {
			await this.speakToCall(session, text);
		}
		return String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
		// No concept of updating on voice — ignore
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// No concept of deleting on voice — ignore
	}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		// No threads on voice — ignore
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {
		// Can't upload files on a phone call — ignore
	}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		const logFile = join(this.workingDir, "log.jsonl");
		try {
			appendFileSync(logFile, JSON.stringify({ ...entry, adapter: "voice" }) + "\n");
		} catch { /* ignore */ }
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			type: "bot_response",
			channel,
			text: text.substring(0, 500),
			ts,
			timestamp: new Date().toISOString(),
		});
	}

	// ==========================================================================
	// Metadata
	// ==========================================================================

	private users = new Map<string, UserInfo>();

	getUser(userId: string): UserInfo | undefined {
		if (!this.users.has(userId)) {
			// Phone numbers as user IDs
			this.users.set(userId, {
				id: userId,
				userName: userId,
				displayName: userId,
			});
		}
		return this.users.get(userId);
	}

	getChannel(_channelId: string): ChannelInfo | undefined {
		return { id: this.channelId, name: "phone" };
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: this.channelId, name: "phone" }];
	}

	// ==========================================================================
	// Context creation
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
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

			respond: async (text: string, shouldLog = true) => {
				if (!shouldLog) return; // Swallow status lines silently
				if (!text.trim()) return;
				// Speak interim responses (e.g. "One moment...")
				if (session) {
					await this.speakToCall(session, text);
				}
			},

			sendFinalResponse: async (text: string) => {
				if (!text.trim()) return;
				if (session) {
					await this.speakToCall(session, text);
				}
				this.logBotResponse(event.channel, text, String(Date.now()));
			},

			respondInThread: async (_text: string) => {
				// No threads on voice
			},

			setTyping: async (_isTyping: boolean) => {
				// Could play a subtle tone, but for now no-op
			},

			uploadFile: async (_filePath: string, _title?: string) => {
				// Can't upload on a phone call
			},

			setWorking: async (_working: boolean) => {
				// No working message concept on voice
			},

			deleteMessage: async () => {
				// Can't delete spoken words
			},

			restartWorking: async (_headerLine?: string) => {
				// No working message to restart
			},
		};
	}

	// ==========================================================================
	// Event queue (for steered events)
	// ==========================================================================

	private eventQueue: MomEvent[] = [];

	enqueueEvent(event: MomEvent): boolean {
		this.eventQueue.push(event);
		log.logInfo(`[voice] Enqueued event: ${event.text.substring(0, 50)}`);

		// Process next tick
		setTimeout(() => this.processEventQueue(), 0);
		return true;
	}

	private async processEventQueue(): Promise<void> {
		while (this.eventQueue.length > 0) {
			const event = this.eventQueue.shift()!;
			if (!this.handler.isRunning(this.channelId)) {
				try {
					await this.handler.handleEvent(event, this);
				} catch (err) {
					log.logWarning(`[voice] Event processing error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	private getActiveCall(): CallSession | null {
		for (const [, session] of this.calls) {
			if (session.status === "connected" && session.mediaWs) {
				return session;
			}
		}
		return null;
	}
}
