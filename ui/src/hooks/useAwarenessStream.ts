/**
 * useAwarenessStream — unified awareness + streaming hook.
 *
 * Single source of truth for the chat pane. Combines:
 * - Polling context.jsonl for historical/cross-channel entries (additive merge)
 * - SSE streaming for live web chat (token, tool_start, tool_end events)
 *
 * The poll never replaces existing entries — it only appends new ones by ID.
 * Streaming entries are built in the same AwarenessEntry format so one
 * component type renders everything.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { apiUrl } from '../api';
import type {
  AwarenessEntry,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from './useAwareness';
import { formatChannel } from './useAwareness';

// Re-export types so consumers don't need to import from useAwareness
export type { AwarenessEntry, ContentBlock, TextContent, ToolCallContent, ToolResultContent };
export { formatChannel };

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'tool_running'
  | 'error';

/** Parse the [timestamp] [channel] [user]: text prefix from user messages */
function parseUserPrefix(text: string): { channel: string; userName: string; strippedText: string } | null {
  const match = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (!match) return null;
  return { channel: match[2], userName: match[3], strippedText: match[4] };
}

function parseContextJsonl(text: string): AwarenessEntry[] {
  const lines = text.trim().split('\n').filter(Boolean);
  const entries: AwarenessEntry[] = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line);

      if (raw.type === 'session') {
        entries.push({
          id: raw.id || `session-${raw.timestamp}`,
          type: 'session',
          timestamp: raw.timestamp,
        });
        continue;
      }

      if (raw.type === 'message' && raw.message) {
        const msg = raw.message;
        const entry: AwarenessEntry = {
          id: raw.id || `msg-${raw.timestamp}`,
          type: 'message',
          timestamp: raw.timestamp,
          role: msg.role,
          content: msg.content,
          model: raw.model,
          stopReason: raw.stopReason,
        };

        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const textBlock = msg.content.find((c: ContentBlock) => c.type === 'text') as TextContent | undefined;
          if (textBlock) {
            const parsed = parseUserPrefix(textBlock.text);
            if (parsed) {
              entry.channel = parsed.channel;
              entry.userName = parsed.userName;
              entry.strippedText = parsed.strippedText;
            }
          }
        }

        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

export interface UseAwarenessStreamReturn {
  entries: AwarenessEntry[];
  isLoading: boolean;
  isStreaming: boolean;
  status: StreamStatus;
  error: string | null;
  sendMessage: (text: string) => void;
  abortStream: () => void;
  clearError: () => void;
}

export function useAwarenessStream(): UseAwarenessStreamReturn {
  const [entries, setEntries] = useState<AwarenessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const streamingIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ========================================================================
  // Poll: fetch context.jsonl and merge new entries additively
  // ========================================================================

  const mergeFromFile = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/file?path=awareness/context.jsonl'));
      if (!response.ok) return;
      const text = await response.text();
      const fetched = parseContextJsonl(text);

      // Find entries we don't already have
      const newEntries = fetched.filter((e) => !knownIdsRef.current.has(e.id));
      if (newEntries.length === 0) return;

      for (const e of newEntries) {
        knownIdsRef.current.add(e.id);
      }

      setEntries((prev) => {
        // Insert new entries before any streaming entries (which sit at the end)
        const streamId = streamingIdRef.current;
        if (streamId) {
          // Find where the streaming user message starts
          const streamIdx = prev.findIndex(
            (e) => e.id === streamId || e.id === `user-${streamId}`,
          );
          if (streamIdx >= 0) {
            return [
              ...prev.slice(0, streamIdx),
              ...newEntries,
              ...prev.slice(streamIdx),
            ];
          }
        }
        return [...prev, ...newEntries];
      });
    } catch {
      // Silently skip poll errors
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    (async () => {
      await mergeFromFile();
      setIsLoading(false);
    })();
  }, [mergeFromFile]);

  // Polling interval
  useEffect(() => {
    pollTimerRef.current = setInterval(mergeFromFile, 10000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [mergeFromFile]);

  // ========================================================================
  // SSE: send message and stream response as AwarenessEntry objects
  // ========================================================================

  const sendMessage = useCallback(async (text: string) => {
    const now = new Date().toISOString();
    const sessionId = String(Date.now());
    const userId = `user-${sessionId}`;
    const assistantId = `assistant-${sessionId}`;

    // Track the streaming session so polls insert before it
    streamingIdRef.current = userId;

    // Optimistic user entry (same shape as awareness entries from context.jsonl)
    const userEntry: AwarenessEntry = {
      id: userId,
      type: 'message',
      timestamp: now,
      role: 'user',
      content: [{ type: 'text', text }],
      channel: 'web',
      userName: 'web-user',
      strippedText: text,
    };

    // Empty assistant entry — will be filled by SSE tokens
    const assistantEntry: AwarenessEntry = {
      id: assistantId,
      type: 'message',
      timestamp: now,
      role: 'assistant',
      content: [],
      isStreaming: true,
    };

    knownIdsRef.current.add(userId);
    knownIdsRef.current.add(assistantId);
    setEntries((prev) => [...prev, userEntry, assistantEntry]);
    setIsStreaming(true);
    setStatus('connecting');
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Retry loop for cold starts (503 = container waking)
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

          processSSEEvent(data, assistantId, setEntries, setStatus, setError);
        }
      }

      // Flush remaining buffer
      if (buffer.startsWith('data: ')) {
        const remaining = buffer.slice(6);
        if (remaining !== '[DONE]') {
          processSSEEvent(remaining, assistantId, setEntries, setStatus, setError);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled — leave entries as-is
      } else {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        setError(errorMessage);
        // Mark assistant entry as failed if it has no content
        setEntries((prev) =>
          prev.map((e) => {
            if (e.id !== assistantId) return e;
            const hasContent = e.content?.some(
              (c) => c.type === 'text' && c.text.trim(),
            );
            if (hasContent) return { ...e, isStreaming: false };
            return {
              ...e,
              content: [{ type: 'text' as const, text: 'Failed to get response.' }],
              isStreaming: false,
            };
          }),
        );
      }
    } finally {
      // Mark streaming done
      setEntries((prev) =>
        prev.map((e) =>
          e.id === assistantId ? { ...e, isStreaming: false } : e,
        ),
      );
      setIsStreaming(false);
      setStatus('idle');
      streamingIdRef.current = null;
      abortControllerRef.current = null;

      // Refetch to pick up the file-written versions and any cross-channel updates
      // The optimistic entries stay (matched by the file-written IDs being different,
      // they'll appear as additional entries — but that's OK, the user sees continuity)
      setTimeout(mergeFromFile, 1000);
    }
  }, [mergeFromFile]);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Mark streaming entry as done
    const aid = streamingIdRef.current;
    if (aid) {
      const assistantId = `assistant-${aid.replace('user-', '')}`;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === assistantId ? { ...e, isStreaming: false } : e,
        ),
      );
    }
    setIsStreaming(false);
    setStatus('idle');
    streamingIdRef.current = null;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  return {
    entries,
    isLoading,
    isStreaming,
    status,
    error,
    sendMessage,
    abortStream,
    clearError,
  };
}

// ============================================================================
// SSE event processing — updates the assistant AwarenessEntry in place
// ============================================================================

function processSSEEvent(
  data: string,
  assistantId: string,
  setEntries: React.Dispatch<React.SetStateAction<AwarenessEntry[]>>,
  setStatus: (s: StreamStatus) => void,
  setError: (e: string | null) => void,
): void {
  try {
    const parsed = JSON.parse(data);

    if (parsed.type === 'token' && parsed.text) {
      setStatus('streaming');
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== assistantId) return e;
          const content = [...(e.content || [])];
          const last = content[content.length - 1];
          if (last && last.type === 'text') {
            content[content.length - 1] = {
              ...last,
              text: (last as TextContent).text + parsed.text,
            };
          } else {
            content.push({ type: 'text' as const, text: parsed.text });
          }
          return { ...e, content };
        }),
      );
    } else if (parsed.type === 'tool_start') {
      setStatus('tool_running');
      const toolBlock: ToolCallContent = {
        type: 'toolCall',
        id: parsed.toolCallId || `tool-${Date.now()}`,
        name: parsed.toolName || parsed.name,
        arguments: parsed.args || {},
      };
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== assistantId) return e;
          return { ...e, content: [...(e.content || []), toolBlock] };
        }),
      );
    } else if (parsed.type === 'tool_end') {
      setStatus('streaming');
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== assistantId) return e;
          const content = (e.content || []).map((c) => {
            if (c.type !== 'toolCall') return c;
            const matchById = parsed.toolCallId && c.id === parsed.toolCallId;
            const matchByName = !parsed.toolCallId && c.name === (parsed.toolName || parsed.name);
            if (matchById || matchByName) {
              // Add a toolResult after this toolCall
              return c;
            }
            return c;
          });

          // Append a tool result entry
          const toolResultBlock: ToolResultContent = {
            type: 'toolResult',
            toolCallId: parsed.toolCallId || '',
            result: parsed.resultPreview || parsed.preview || '',
            isError: parsed.isError,
          };
          return { ...e, content: [...content, toolResultBlock] };
        }),
      );
    } else if (parsed.type === 'error') {
      setError(parsed.message || 'Stream error');
    }
    // heartbeat, run_complete, status — silently ignored
  } catch {
    // Non-JSON — skip
  }
}
