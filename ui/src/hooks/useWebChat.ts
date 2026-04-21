/**
 * useWebChat — POST the user's message, wait for the ack, then rely on the
 * awareness stream for everything else.
 *
 * The container's `/web/chat` endpoint is a POST-and-go: it accepts the
 * message, returns 200, and fires the agent run. The agent's output is
 * written to `awareness/context.jsonl` and pushed to all SSE subscribers
 * via the in-process awareness bus. That stream is the single source of
 * truth for the UI — we don't parse tokens here.
 *
 * The `isStreaming` flag stays true for a short window after POST so the
 * input bar shows the stop affordance. The awareness stream itself tells
 * the user when the agent is typing — we don't need a separate signal.
 */

import { useCallback, useRef, useState } from 'react';
import { apiUrl } from '../api';

export type StreamStatus = 'idle' | 'sending' | 'error';

export interface UseWebChatReturn {
  isStreaming: boolean;
  status: StreamStatus;
  error: string | null;
  sendMessage: (text: string) => void;
  abortStream: () => void;
  clearError: () => void;
}

export function useWebChat(): UseWebChatReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string) => {
    setIsStreaming(true);
    setStatus('sending');
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      let resp: Response | null = null;
      // Short retry loop for cold-start: container boot takes 1-8s.
      for (let attempt = 1; attempt <= 15; attempt++) {
        resp = await fetch(apiUrl('/web/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
          signal: controller.signal,
        });
        if (resp.status !== 503) break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      if (!resp || !resp.ok) {
        const body = resp ? await resp.text() : 'No response';
        throw new Error(body || `HTTP ${resp?.status}`);
      }
      // The ack body is cheap JSON: { ok: true, status, channelId, ts }.
      // We don't need it — the awareness stream carries everything.
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Cancelled — quiet
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setStatus('error');
      }
    } finally {
      setIsStreaming(false);
      if (status !== 'error') setStatus('idle');
      abortControllerRef.current = null;
    }
  }, [status]);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStatus('idle');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  return { isStreaming, status, error, sendMessage, abortStream, clearError };
}
