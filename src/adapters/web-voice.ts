/**
 * WebVoiceHandler — browser voice chat via WebSocket.
 *
 * Receives PCM 16kHz audio from the browser mic, pipes to ElevenLabs STT,
 * runs the agent on each utterance, and streams TTS audio (mp3) back
 * to the browser for playback.
 *
 * Protocol (browser ↔ server):
 *   Browser → Server:
 *     - Binary: PCM 16-bit 16kHz audio chunks from mic
 *     - JSON: { type: "stop" } to end session
 *   Server → Browser:
 *     - Binary: mp3 audio chunks (TTS output)
 *     - JSON: { type: "listening" | "thinking" | "speaking" | "error" | "transcript" }
 */

import WebSocket from "ws";
import * as log from "../log.js";
import { createSttSession, type SttConfig, type SttSession } from "./voice-stt.js";
import { textToSpeechStreaming, type TtsConfig } from "./voice-tts.js";
import type { MomEvent, MomHandler, PlatformAdapter, MomContext, ChannelInfo, UserInfo } from "./types.js";
import type { ChannelStore } from "../store.js";
import { appendFileSync } from "fs";
import { join } from "path";

export interface WebVoiceConfig {
	elevenlabsApiKey: string;
	elevenlabsVoiceId: string;
	elevenlabsModelId?: string;
	workingDir: string;
}

/**
 * Handle a single browser voice WebSocket session.
 * Each connection gets its own STT session and voice pipeline.
 */
export function handleWebVoiceSession(
	ws: WebSocket,
	config: WebVoiceConfig,
	handler: MomHandler,
	adapter: WebVoiceBridgeAdapter,
): void {
	log.logInfo("[web-voice] Browser voice session started");

	const sttConfig: SttConfig = {
		apiKey: config.elevenlabsApiKey,
		audioFormat: "pcm_16000",
		vadSilenceThreshold: 1.2,
	};

	const ttsConfig: TtsConfig = {
		apiKey: config.elevenlabsApiKey,
		voiceId: config.elevenlabsVoiceId,
		modelId: config.elevenlabsModelId,
		outputFormat: "mp3_44100",
	};

	let sttSession: SttSession | null = null;

	const sendControl = (msg: Record<string, unknown>) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

	// Start STT
	sttSession = createSttSession(
		sttConfig,
		// On committed utterance
		(text: string) => {
			if (!text.trim()) return;
			log.logInfo(`[web-voice] Utterance: "${text}"`);
			sendControl({ type: "transcript", text });
			sendControl({ type: "thinking" });

			// Set the active WebSocket and TTS config on the bridge adapter
			adapter.setActiveSession(ws, ttsConfig);

			const event: MomEvent = {
				type: "dm",
				channel: "web-voice",
				ts: String(Date.now()),
				user: "web-user",
				text,
			};

			if (handler.isRunning("web-voice")) {
				handler.handleSteer(event, adapter);
			} else {
				handler.handleEvent(event, adapter).catch((err) => {
					log.logWarning(`[web-voice] handleEvent error: ${err instanceof Error ? err.message : String(err)}`);
					sendControl({ type: "error", message: "Agent error" });
					sendControl({ type: "listening" });
				});
			}
		},
		// On partial transcript
		(partial: string) => {
			sendControl({ type: "partial", text: partial });
		},
		// On STT error
		(err: Error) => {
			log.logWarning(`[web-voice] STT error: ${err.message}`);
			sendControl({ type: "error", message: "Speech recognition error" });
		},
	);

	sendControl({ type: "listening" });

	ws.on("message", (data, isBinary) => {
		if (isBinary) {
			// Binary = PCM audio from browser mic
			if (sttSession?.connected) {
				// Convert to base64 for ElevenLabs
				const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
				sttSession.sendAudio(buf.toString("base64"));
			}
		} else {
			// Text = JSON control message
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === "stop") {
					log.logInfo("[web-voice] Client requested stop");
					sttSession?.close();
					ws.close();
				}
			} catch {
				// ignore
			}
		}
	});

	ws.on("close", () => {
		log.logInfo("[web-voice] Browser voice session closed");
		sttSession?.close();
		sttSession = null;
		adapter.clearActiveSession();
	});

	ws.on("error", (err) => {
		log.logWarning(`[web-voice] WebSocket error: ${err.message}`);
		sttSession?.close();
		sttSession = null;
		adapter.clearActiveSession();
	});
}

/**
 * WebVoiceBridgeAdapter — lightweight PlatformAdapter that routes agent
 * responses back to the browser as TTS audio.
 *
 * This adapter is shared across web voice sessions but only one session
 * can be active at a time (set via setActiveSession).
 */
export class WebVoiceBridgeAdapter implements PlatformAdapter {
	readonly name = "web-voice";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Voice Chat
You are in a live voice conversation via the browser. Keep responses concise and conversational — the user hears everything you say spoken aloud.
Do not use markdown formatting, links, or code blocks — they don't translate to speech.
Be direct, warm, and natural. Avoid long lists or complex structured output.
If you need to do something that takes time, say "One moment" or "Let me check on that" so the caller knows you're working.`;

	private workingDir: string;
	private activeWs: WebSocket | null = null;
	private activeTtsConfig: TtsConfig | null = null;
	private handler!: MomHandler;

	constructor(workingDir: string) {
		this.workingDir = workingDir;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	setActiveSession(ws: WebSocket, ttsConfig: TtsConfig): void {
		this.activeWs = ws;
		this.activeTtsConfig = ttsConfig;
	}

	clearActiveSession(): void {
		this.activeWs = null;
		this.activeTtsConfig = null;
	}

	async start(): Promise<void> {
		log.logInfo("[web-voice] Bridge adapter ready");
	}
	async stop(): Promise<void> {
		this.clearActiveSession();
	}

	dispatch = undefined;

	private sendControl(msg: Record<string, unknown>): void {
		if (this.activeWs?.readyState === WebSocket.OPEN) {
			this.activeWs.send(JSON.stringify(msg));
		}
	}

	private async speakToClient(text: string): Promise<void> {
		if (!this.activeWs || this.activeWs.readyState !== WebSocket.OPEN || !this.activeTtsConfig) return;

		this.sendControl({ type: "speaking" });

		try {
			await textToSpeechStreaming(text, this.activeTtsConfig, (base64Audio: string) => {
				if (this.activeWs?.readyState === WebSocket.OPEN) {
					// Send as binary (decoded from base64)
					this.activeWs.send(Buffer.from(base64Audio, "base64"));
				}
			});

			// Signal end of audio
			this.sendControl({ type: "listening" });
		} catch (err) {
			log.logWarning(`[web-voice] TTS error: ${err instanceof Error ? err.message : String(err)}`);
			this.sendControl({ type: "listening" });
		}
	}

	async postMessage(_channel: string, text: string): Promise<string> {
		await this.speakToClient(text);
		return String(Date.now());
	}

	async updateMessage(): Promise<void> {}
	async deleteMessage(): Promise<void> {}
	async postInThread(): Promise<string> { return String(Date.now()); }
	async uploadFile(): Promise<void> {}

	logToFile(entry: object): void {
		try {
			appendFileSync(join(this.workingDir, "log.jsonl"), JSON.stringify({ ...entry, adapter: "web-voice" }) + "\n");
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
		return { id: "web-voice", name: "voice" };
	}

	getAllUsers(): UserInfo[] { return Array.from(this.users.values()); }
	getAllChannels(): ChannelInfo[] { return [{ id: "web-voice", name: "voice" }]; }

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		let lastSpokenText: string | null = null;

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
			channelName: "voice",
			channels: this.getAllChannels(),
			users: this.getAllUsers(),

			respond: async (text: string, shouldLog = true) => {
				if (!text.trim()) return;

				// Tool call labels — speak them
				if (!shouldLog && text.startsWith("_→")) {
					const clean = text.replace(/^_→\s*/, "").replace(/_$/, "").trim();
					if (clean) {
						lastSpokenText = clean;
						await this.speakToClient(clean);
					}
					return;
				}

				if (!shouldLog) return;
				if (text.includes("💭")) return;

				lastSpokenText = text;
				await this.speakToClient(text);
			},

			sendFinalResponse: async (text: string) => {
				if (!text.trim()) return;
				if (text !== lastSpokenText) {
					await this.speakToClient(text);
				}
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
			if (!this.handler.isRunning("web-voice")) {
				try { await this.handler.handleEvent(event, this); }
				catch (err) { log.logWarning(`[web-voice] Event error: ${err instanceof Error ? err.message : String(err)}`); }
			}
		}
	}
}
