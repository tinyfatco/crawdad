/**
 * useVoiceChat — browser mic capture + WebSocket voice chat.
 *
 * Captures mic audio as PCM 16kHz, streams to /voice/stream over WebSocket.
 * Receives mp3 audio back and plays through speakers.
 * Receives JSON control messages for state updates.
 */

import { useState, useRef, useCallback } from 'react';
import { apiUrl } from '../api';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface UseVoiceChatReturn {
  state: VoiceState;
  /** Current partial transcript (interim STT result) */
  partial: string;
  /** Last committed transcript */
  transcript: string;
  /** Start voice session */
  start: () => Promise<void>;
  /** Stop voice session */
  stop: () => void;
  /** Error message if state is 'error' */
  error: string | null;
}

// AudioWorklet processor code — captures PCM 16kHz and posts to main thread
const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // input[0] is Float32Array of samples
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

function getVoiceWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = loc.pathname.endsWith('/') ? loc.pathname.slice(0, -1) : loc.pathname;
  return `${proto}//${loc.host}${base}/voice/stream`;
}

export function useVoiceChat(): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceState>('idle');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Queue for mp3 audio chunks to play sequentially
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);

  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === 'closed') return;

    isPlayingRef.current = true;

    // Concatenate all queued chunks into one buffer for smoother playback
    const chunks = audioQueueRef.current.splice(0);
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    try {
      const audioBuffer = await ctx.decodeAudioData(combined.buffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        isPlayingRef.current = false;
        // Play next batch if more arrived while we were playing
        if (audioQueueRef.current.length > 0) {
          playNextChunk();
        }
      };
      source.start();
    } catch {
      // If decoding fails (partial mp3 frame), skip
      isPlayingRef.current = false;
      if (audioQueueRef.current.length > 0) {
        playNextChunk();
      }
    }
  }, []);

  const stop = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
      } catch { /* ignore */ }
      wsRef.current.close();
      wsRef.current = null;
    }

    // Stop mic
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setState('idle');
    setPartial('');
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle') return;

    setState('connecting');
    setError(null);
    setPartial('');
    setTranscript('');

    try {
      // Request mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Create AudioContext at 16kHz for PCM capture
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // Register worklet
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Connect mic → worklet
      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      workletNodeRef.current = workletNode;
      source.connect(workletNode);
      workletNode.connect(audioCtx.destination); // needed to keep the pipeline alive

      // Open WebSocket
      const wsUrl = getVoiceWsUrl();
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setState('listening');

        // Stream mic audio to server
        workletNode.port.onmessage = (e: MessageEvent) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.data as Float32Array;
          // Convert Float32 [-1,1] to Int16 PCM
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          ws.send(int16.buffer);
        };
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary = mp3 audio from TTS
          audioQueueRef.current.push(event.data);
          // Wait a bit to accumulate chunks before decoding
          setTimeout(() => playNextChunk(), 200);
        } else {
          // JSON control message
          try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case 'listening':
                setState('listening');
                break;
              case 'thinking':
                setState('thinking');
                break;
              case 'speaking':
                setState('speaking');
                break;
              case 'partial':
                setPartial(msg.text || '');
                break;
              case 'transcript':
                setTranscript(msg.text || '');
                setPartial('');
                break;
              case 'error':
                setError(msg.message || 'Voice error');
                break;
            }
          } catch { /* ignore */ }
        }
      };

      ws.onclose = () => {
        stop();
      };

      ws.onerror = () => {
        setError('Voice connection failed');
        stop();
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Mic access denied';
      setError(msg);
      setState('error');
      stop();
    }
  }, [state, stop, playNextChunk]);

  return { state, partial, transcript, start, stop, error };
}
