/**
 * useStreamingChat — SSE streaming hook for troublemaker's web adapter.
 *
 * Sends messages via POST /web/chat and reads SSE events from the response.
 * Speaks troublemaker's native protocol: token, tool_start, tool_end, run_complete.
 */

import { useState, useCallback, useRef } from 'react';
import { apiUrl } from '../api';

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  isRunning: boolean;
  isError?: boolean;
  resultPreview?: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolBlock {
  type: 'tool';
  toolCall: ToolCall;
}

export type ContentBlock = TextBlock | ToolBlock;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  timestamp: Date;
  isStreaming?: boolean;
}

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'tool_running'
  | 'error';

function processStreamEvent(
  data: string,
  assistantId: string,
  setStatus: (s: StreamStatus) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setActiveTool: (t: ToolCall | null) => void,
): void {
  if (data === '[DONE]') return;

  try {
    const parsed = JSON.parse(data);

    if (parsed.type === 'token' && parsed.text) {
      setStatus('streaming');
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantId) return msg;
          const blocks = [...msg.blocks];
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === 'text') {
            blocks[blocks.length - 1] = {
              ...lastBlock,
              text: lastBlock.text + parsed.text,
            };
          } else {
            blocks.push({ type: 'text', text: parsed.text });
          }
          return { ...msg, blocks };
        }),
      );
    } else if (parsed.type === 'tool_start') {
      const toolCall: ToolCall = {
        id: parsed.toolCallId,
        name: parsed.toolName || parsed.name,
        args: parsed.args,
        isRunning: true,
      };
      setStatus('tool_running');
      setActiveTool(toolCall);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? { ...msg, blocks: [...msg.blocks, { type: 'tool', toolCall }] }
            : msg,
        ),
      );
    } else if (parsed.type === 'tool_end') {
      setStatus('streaming');
      setActiveTool(null);
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantId) return msg;
          const blocks = msg.blocks.map((block) => {
            if (block.type !== 'tool') return block;
            const matchById =
              parsed.toolCallId && block.toolCall.id === parsed.toolCallId;
            const matchByName =
              !parsed.toolCallId &&
              block.toolCall.name === (parsed.toolName || parsed.name) &&
              block.toolCall.isRunning;
            if (matchById || matchByName) {
              return {
                ...block,
                toolCall: {
                  ...block.toolCall,
                  isRunning: false,
                  isError: parsed.isError,
                  resultPreview: parsed.resultPreview || parsed.preview,
                },
              };
            }
            return block;
          });
          return { ...msg, blocks };
        }),
      );
    } else if (parsed.type === 'error') {
      // Error events get appended as text
    } else if (parsed.type === 'run_complete') {
      // Run finished — handled by stream close
    }
    // heartbeat events are silently ignored
  } catch {
    // Non-JSON data — skip
  }
}

export interface UseStreamingChatReturn {
  messages: Message[];
  isStreaming: boolean;
  status: StreamStatus;
  activeTool: ToolCall | null;
  error: string | null;
  sendMessage: (text: string) => void;
  abortStream: () => void;
  clearError: () => void;
  clearMessages: () => void;
}

export function useStreamingChat(): UseStreamingChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [activeTool, setActiveTool] = useState<ToolCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string) => {
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: new Date(),
    };

    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      blocks: [],
      timestamp: new Date(),
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setIsStreaming(true);
    setStatus('connecting');
    setError(null);
    setActiveTool(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(apiUrl('/web/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

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

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'error') {
              setError(parsed.message || 'Stream error');
              continue;
            }
          } catch {
            // Not JSON or parse error — process as raw event
          }

          processStreamEvent(
            data,
            assistantId,
            setStatus,
            setMessages,
            setActiveTool,
          );
        }
      }

      // Flush remaining buffer
      if (buffer.startsWith('data: ')) {
        const remaining = buffer.slice(6);
        if (remaining !== '[DONE]') {
          processStreamEvent(
            remaining,
            assistantId,
            setStatus,
            setMessages,
            setActiveTool,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled
      } else {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        setError(errorMessage);
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== assistantId) return msg;
            const hasContent = msg.blocks.some(
              (b) => b.type === 'text' && b.text,
            );
            if (hasContent) return { ...msg, isStreaming: false };
            return {
              ...msg,
              blocks: [{ type: 'text', text: 'Failed to get response.' }],
              isStreaming: false,
            };
          }),
        );
      }
    } finally {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId ? { ...msg, isStreaming: false } : msg,
        ),
      );
      setIsStreaming(false);
      setStatus('idle');
      setActiveTool(null);
      abortControllerRef.current = null;
    }
  }, []);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStatus('idle');
    setActiveTool(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
    setStatus('idle');
    setActiveTool(null);
  }, []);

  return {
    messages,
    isStreaming,
    status,
    activeTool,
    error,
    sendMessage,
    abortStream,
    clearError,
    clearMessages,
  };
}
