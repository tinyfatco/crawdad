/**
 * useAwareness — loads and parses the agent's unified awareness context.
 *
 * Reads awareness/context.jsonl via the file API, parses the pi-agent-core
 * message format, and returns structured entries for rendering.
 */

import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '../api';

/** Content block types from pi-agent-core */
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'toolResult';
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export type ContentBlock = TextContent | ThinkingContent | ToolCallContent | ToolResultContent;

export interface AwarenessEntry {
  id: string;
  type: 'session' | 'message';
  timestamp: string;
  role?: 'user' | 'assistant' | 'toolResult';
  content?: ContentBlock[];
  /** Extracted from user message text prefix: [timestamp] [channel] [user]: text */
  channel?: string;
  userName?: string;
  /** The actual message text with the prefix stripped */
  strippedText?: string;
  /** Model info for assistant messages */
  model?: string;
  stopReason?: string;
}

/** Parse the [timestamp] [channel] [user]: text prefix from user messages */
function parseUserPrefix(text: string): { channel: string; userName: string; strippedText: string } | null {
  // Format: [2026-03-14 03:59:05+00:00] [zip-chat] [alexgarcia042]: boop
  const match = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (!match) return null;
  return {
    channel: match[2],
    userName: match[3],
    strippedText: match[4],
  };
}

/** Normalize channel identifiers to display-friendly names */
export function formatChannel(channel: string): { label: string; type: string } {
  if (channel === 'web' || channel === 'web-user') return { label: 'web', type: 'web' };
  if (channel.startsWith('email-')) return { label: 'email', type: 'email' };
  if (channel.startsWith('telegram:') || /^-?\d+$/.test(channel)) return { label: channel.replace('telegram:', ''), type: 'telegram' };
  if (channel === 'DM:Alex' || channel.startsWith('DM:')) return { label: channel, type: 'telegram' };
  if (/^[CDG]/.test(channel)) return { label: `#${channel}`, type: 'slack' };
  // Named slack channels
  if (['general', 'zip-chat', 'random'].includes(channel) || channel.includes('-')) {
    return { label: `#${channel}`, type: 'slack' };
  }
  return { label: channel, type: 'unknown' };
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

        // Parse channel/user from user message text
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

export function useAwareness() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['awareness-context'],
    queryFn: async () => {
      const response = await fetch(apiUrl('/api/file?path=awareness/context.jsonl'));
      if (!response.ok) return [];
      const text = await response.text();
      return parseContextJsonl(text);
    },
    staleTime: 5000,
    refetchInterval: 10000, // Poll for cross-channel updates
  });

  return {
    entries: data || [],
    isLoading,
    error,
    refetch,
  };
}
