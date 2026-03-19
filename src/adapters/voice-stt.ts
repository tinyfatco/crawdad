/**
 * ElevenLabs realtime STT via WebSocket.
 *
 * Accepts base64-encoded audio chunks (mulaw 8kHz from Twilio),
 * emits transcribed text on voice activity detection (VAD) commit.
 */

import WebSocket from "ws";
import * as log from "../log.js";

export interface SttConfig {
	apiKey: string;
	/** Silence threshold in seconds for VAD (0.3-3.0, default 1.5) */
	vadSilenceThreshold?: number;
	/** Language code (ISO 639-1), e.g. "en" */
	languageCode?: string;
}

export interface SttSession {
	/** Send a base64-encoded audio chunk (mulaw 8kHz) */
	sendAudio(base64Payload: string): void;
	/** Close the STT session */
	close(): void;
	/** Whether the session is connected */
	readonly connected: boolean;
}

/**
 * Open a realtime STT session with ElevenLabs.
 *
 * @param config STT configuration
 * @param onTranscript Called when a complete utterance is committed (VAD detected end of speech)
 * @param onPartial Called with partial transcript updates (optional, for interim display)
 * @param onError Called on connection errors
 */
export function createSttSession(
	config: SttConfig,
	onTranscript: (text: string) => void,
	onPartial?: (text: string) => void,
	onError?: (err: Error) => void,
): SttSession {
	const vadThreshold = config.vadSilenceThreshold ?? 1.5;
	const langCode = config.languageCode ?? "en";

	const params = new URLSearchParams({
		model_id: "scribe_v1",
		audio_format: "ulaw_8000",
		commit_strategy: "vad",
		vad_silence_threshold_secs: String(vadThreshold),
		language_code: langCode,
	});

	const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;

	let isConnected = false;
	let ws: WebSocket | null = null;

	ws = new WebSocket(url, {
		headers: { "xi-api-key": config.apiKey },
	});

	ws.on("open", () => {
		isConnected = true;
		log.logInfo("[voice-stt] ElevenLabs STT session connected");
	});

	ws.on("message", (data) => {
		try {
			const msg = JSON.parse(data.toString());

			switch (msg.type) {
				case "session_started":
					log.logInfo(`[voice-stt] Session started: ${msg.session_id}`);
					break;

				case "partial_transcript": {
					const partial = msg.text?.trim();
					if (partial && onPartial) {
						onPartial(partial);
					}
					break;
				}

				case "committed_transcript":
				case "committed_transcript_with_timestamps": {
					const text = msg.text?.trim();
					if (text) {
						log.logInfo(`[voice-stt] Committed: "${text}"`);
						onTranscript(text);
					}
					break;
				}

				default:
					// Log all unhandled message types for debugging
					log.logInfo(`[voice-stt] Message: ${JSON.stringify(msg).substring(0, 300)}`);
					// Errors come as various types ending in "_error"
					if (msg.type?.includes("error")) {
						log.logWarning(`[voice-stt] Error: ${msg.type} - ${msg.message || JSON.stringify(msg)}`);
						onError?.(new Error(`STT error: ${msg.type}`));
					}
					break;
			}
		} catch (err) {
			log.logWarning(`[voice-stt] Failed to parse message: ${err}`);
		}
	});

	ws.on("error", (err) => {
		log.logWarning(`[voice-stt] WebSocket error: ${err.message}`);
		onError?.(err);
	});

	ws.on("close", (code, reason) => {
		isConnected = false;
		log.logInfo(`[voice-stt] Session closed: ${code} ${reason}`);
	});

	return {
		sendAudio(base64Payload: string) {
			if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify({
				type: "input_audio_chunk",
				audio_chunk: base64Payload,
			}));
		},

		close() {
			if (ws) {
				isConnected = false;
				ws.close();
				ws = null;
			}
		},

		get connected() {
			return isConnected;
		},
	};
}
