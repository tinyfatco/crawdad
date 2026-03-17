/**
 * useWebChat — SSE streaming for the active web chat turn.
 *
 * Sends messages via POST /web/chat and reads token-level SSE events.
 * Returns a single in-progress AwarenessEntry that the ChatPane renders
 * at the bottom of the awareness stream. When the turn completes,
 * streamingEntry goes null — the completed entry arrives via the
 * awareness stream (from context.jsonl).
 */

import { useState, useCallback, useRef } from 'react';
import { apiUrl } from '../api';
import type { AwarenessEntry } from '../types';

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'tool_running'
  | 'error';

export interface UseWebChatReturn {
  /** The user's message, shown optimistically while streaming */
  userEntry: AwarenessEntry | null;
  /** The assistant's in-progress response */
  streamingEntry: AwarenessEntry | null;
  isStreaming: boolean;
  status: StreamStatus;
  error: string | null;
  sendMessage: (text: string) => void;
  abortStream: () => void;
  clearError: () => void;
}

export function useWebChat(): UseWebChatReturn {
  const [userEntry, setUserEntry] = useState<AwarenessEntry | null>(null);
  const [streamingEntry, setStreamingEntry] = useState<AwarenessEntry | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string) => {
    const now = new Date().toISOString();

    // Optimistic user entry
    const user: AwarenessEntry = {
      id: `live-user-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'user',
      content: [{ type: 'text', text }],
      channel: 'web',
      userName: 'user',
      strippedText: text,
    };

    // Empty assistant entry — filled by SSE tokens
    const assistant: AwarenessEntry = {
      id: `live-assistant-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'assistant',
      content: [],
      isStreaming: true,
    };

    setUserEntry(user);
    setStreamingEntry(assistant);
    setIsStreaming(true);
    setStatus('connecting');
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Retry loop for cold starts
      let response: Response | null = null;
      for (let attempt = 1; attempt <= 30; attempt++) {
        response = await fetch(apiUrl('/web/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
          signal: controller.signal,
        });
        if (response.status === 503) {
          setStatus('connecting');
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        break;
      }

      if (!response || !response.ok) {
        const errText = response ? await response.text() : 'No response';
        throw new Error(errText || `HTTP ${response?.status}`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          processEvent(data, setStreamingEntry, setStatus, setError);
        }
      }

      if (buffer.startsWith('data: ')) {
        const remaining = buffer.slice(6);
        if (remaining !== '[DONE]') {
          processEvent(remaining, setStreamingEntry, setStatus, setError);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setStreamingEntry((prev) => {
          if (!prev) return null;
          const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
          if (hasContent) return { ...prev, isStreaming: false };
          return { ...prev, content: [{ type: 'text', text: 'Failed to get response.' }], isStreaming: false };
        });
      }
    } finally {
      // Mark streaming done but keep entries visible —
      // they'll be cleaned up when the awareness stream delivers the real versions
      setStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
      setIsStreaming(false);
      setStatus('idle');
      abortControllerRef.current = null;
    }
  }, []);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
    setIsStreaming(false);
    setStatus('idle');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  return { userEntry, streamingEntry, isStreaming, status, error, sendMessage, abortStream, clearError };
}

// ============================================================================
// SSE event → update streaming AwarenessEntry
// ============================================================================

function processEvent(
  data: string,
  setEntry: React.Dispatch<React.SetStateAction<AwarenessEntry | null>>,
  setStatus: (s: StreamStatus) => void,
  setError: (e: string | null) => void,
): void {
  try {
    const parsed = JSON.parse(data);

    // Token-level streaming deltas — append to last block of same type
    if (parsed.type === 'text_delta' && parsed.delta) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        const content = [...(prev.content || [])];
        const last = content[content.length - 1];
        if (last && last.type === 'text') {
          content[content.length - 1] = { ...last, text: last.text + parsed.delta };
        } else {
          content.push({ type: 'text' as const, text: parsed.delta });
        }
        return { ...prev, content };
      });
    } else if (parsed.type === 'thinking_delta' && parsed.delta) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        const content = [...(prev.content || [])];
        const last = content[content.length - 1];
        if (last && last.type === 'thinking') {
          content[content.length - 1] = { ...last, thinking: (last as any).thinking + parsed.delta };
        } else {
          content.push({ type: 'thinking' as const, thinking: parsed.delta });
        }
        return { ...prev, content };
      });
    // Complete content blocks (legacy / fallback)
    } else if (parsed.type === 'text' && parsed.text) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        // If deltas already built up text, replace last text block
        const content = [...(prev.content || [])];
        const lastIdx = content.length - 1;
        if (lastIdx >= 0 && content[lastIdx].type === 'text') {
          content[lastIdx] = { type: 'text' as const, text: parsed.text };
          return { ...prev, content };
        }
        return { ...prev, content: [...content, { type: 'text' as const, text: parsed.text }] };
      });
    } else if (parsed.type === 'thinking' && parsed.thinking) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        return { ...prev, content: [...(prev.content || []), { type: 'thinking' as const, thinking: parsed.thinking }] };
      });
    } else if (parsed.type === 'toolCall') {
      setStatus('tool_running');
      setEntry((prev) => {
        if (!prev) return prev;
        return { ...prev, content: [...(prev.content || []), {
          type: 'toolCall' as const,
          id: parsed.id || `tool-${Date.now()}`,
          name: parsed.name,
          arguments: parsed.arguments || {},
        }] };
      });
    } else if (parsed.type === 'toolResult') {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        return { ...prev, content: [...(prev.content || []), {
          type: 'toolResult' as const,
          toolCallId: parsed.toolCallId || '',
          result: parsed.result || '',
          isError: parsed.isError,
        }] };
      });
    } else if (parsed.type === 'error') {
      setError(parsed.message || 'Stream error');
    }
    // heartbeat, run_complete, status — ignored
  } catch {
    // Non-JSON — skip
  }
}
