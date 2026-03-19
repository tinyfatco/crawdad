/**
 * ElevenLabs streaming TTS via WebSocket.
 *
 * Accepts text, streams back base64-encoded audio chunks.
 * Output format: mulaw 8kHz (Twilio-native).
 */

import WebSocket from "ws";
import * as log from "../log.js";

export interface TtsConfig {
	apiKey: string;
	voiceId: string;
	modelId?: string;
}

export interface TtsResult {
	/** Base64-encoded mulaw 8kHz audio chunks, in order */
	audioChunks: string[];
}

/**
 * Convert text to speech using ElevenLabs WebSocket API.
 * Returns base64-encoded mulaw 8kHz audio suitable for Twilio Media Streams.
 */
export async function textToSpeech(text: string, config: TtsConfig): Promise<TtsResult> {
	const modelId = config.modelId || "eleven_turbo_v2_5";
	const voiceId = config.voiceId;

	const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`;

	return new Promise<TtsResult>((resolve, reject) => {
		const audioChunks: string[] = [];
		let resolved = false;

		const ws = new WebSocket(url, {
			headers: { "xi-api-key": config.apiKey },
		});

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				ws.close();
				reject(new Error("TTS WebSocket timeout (15s)"));
			}
		}, 15000);

		ws.on("open", () => {
			// Initialize the connection with voice settings
			ws.send(JSON.stringify({
				text: " ",
				voice_settings: {
					stability: 0.5,
					similarity_boost: 0.8,
					use_speaker_boost: false,
				},
				generation_config: {
					chunk_length_schedule: [120, 160, 250, 290],
				},
			}));

			// Send the actual text
			ws.send(JSON.stringify({ text: text + " " }));

			// Close the text stream (signals no more text coming)
			ws.send(JSON.stringify({ text: "" }));
		});

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.audio) {
					audioChunks.push(msg.audio);
				}
				if (msg.isFinal) {
					clearTimeout(timeout);
					resolved = true;
					ws.close();
					resolve({ audioChunks });
				}
			} catch (err) {
				log.logWarning(`[voice-tts] Failed to parse message: ${err}`);
			}
		});

		ws.on("error", (err) => {
			if (!resolved) {
				clearTimeout(timeout);
				resolved = true;
				reject(new Error(`TTS WebSocket error: ${err.message}`));
			}
		});

		ws.on("close", () => {
			if (!resolved) {
				clearTimeout(timeout);
				resolved = true;
				// If we got chunks, resolve with what we have
				if (audioChunks.length > 0) {
					resolve({ audioChunks });
				} else {
					reject(new Error("TTS WebSocket closed without audio"));
				}
			}
		});
	});
}

/**
 * Streaming TTS — calls onChunk for each audio chunk as it arrives.
 * Useful for piping directly to Twilio Media Streams for lowest latency.
 */
export async function textToSpeechStreaming(
	text: string,
	config: TtsConfig,
	onChunk: (base64Audio: string) => void,
): Promise<void> {
	const modelId = config.modelId || "eleven_turbo_v2_5";
	const voiceId = config.voiceId;

	const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`;

	return new Promise<void>((resolve, reject) => {
		let resolved = false;

		const ws = new WebSocket(url, {
			headers: { "xi-api-key": config.apiKey },
		});

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				ws.close();
				reject(new Error("TTS streaming WebSocket timeout (30s)"));
			}
		}, 30000);

		ws.on("open", () => {
			ws.send(JSON.stringify({
				text: " ",
				voice_settings: {
					stability: 0.5,
					similarity_boost: 0.8,
					use_speaker_boost: false,
				},
				generation_config: {
					chunk_length_schedule: [120, 160, 250, 290],
				},
			}));

			ws.send(JSON.stringify({ text: text + " " }));
			ws.send(JSON.stringify({ text: "" }));
		});

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.audio) {
					onChunk(msg.audio);
				}
				if (msg.isFinal) {
					clearTimeout(timeout);
					resolved = true;
					ws.close();
					resolve();
				}
			} catch (err) {
				log.logWarning(`[voice-tts] Failed to parse streaming message: ${err}`);
			}
		});

		ws.on("error", (err) => {
			if (!resolved) {
				clearTimeout(timeout);
				resolved = true;
				reject(new Error(`TTS streaming WebSocket error: ${err.message}`));
			}
		});

		ws.on("close", () => {
			if (!resolved) {
				clearTimeout(timeout);
				resolved = true;
				resolve();
			}
		});
	});
}
