/**
 * Shared types for the awareness stream UI.
 *
 * AwarenessEntry is the universal render type — everything in the chat pane
 * is one of these, whether it came from context.jsonl or live SSE streaming.
 */

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
  /** True while SSE is actively streaming this entry */
  isStreaming?: boolean;
  /** True if this is an ambient engagement trigger */
  isAmbient?: boolean;
}

/** Parse the [timestamp] [channel] [user]: text prefix from user messages */
export function parseUserPrefix(text: string): { channel: string; userName: string; strippedText: string } | null {
  const match = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (!match) return null;
  return { channel: match[2], userName: match[3], strippedText: match[4] };
}

/** Normalize channel identifiers to display-friendly names */
export function formatChannel(channel: string): { label: string; type: string } {
  if (channel === 'heartbeat' || channel.startsWith('heartbeat:')) return { label: 'heartbeat', type: 'heartbeat' };
  if (channel === 'web' || channel === 'web-user') return { label: 'web', type: 'web' };
  if (channel.startsWith('email-')) return { label: 'email', type: 'email' };
  if (channel.startsWith('telegram:') || /^-?\d+$/.test(channel)) return { label: channel.replace('telegram:', ''), type: 'telegram' };
  if (channel === 'DM:Alex' || channel.startsWith('DM:')) return { label: channel, type: 'telegram' };
  if (/^[CDG]/.test(channel)) return { label: `#${channel}`, type: 'slack' };
  if (['general', 'zip-chat', 'random'].includes(channel) || channel.includes('-')) {
    return { label: `#${channel}`, type: 'slack' };
  }
  return { label: channel, type: 'unknown' };
}

/** Parse a single JSON line from context.jsonl into an AwarenessEntry */
export function parseContextLine(line: string): AwarenessEntry | null {
  try {
    const raw = JSON.parse(line);

    if (raw.type === 'session') {
      return {
        id: raw.id || `session-${raw.timestamp}`,
        type: 'session',
        timestamp: raw.timestamp,
      };
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
          // Strip <session_context> before parsing — it precedes the [timestamp] prefix
          const cleaned = textBlock.text.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, '').trim();
          const parsed = parseUserPrefix(cleaned);
          if (parsed) {
            entry.channel = parsed.channel;
            entry.userName = parsed.userName;
            entry.strippedText = parsed.strippedText;
            // Detect ambient engagement messages
            if (parsed.strippedText.startsWith('[AMBIENT]')) {
              entry.isAmbient = true;
              entry.userName = 'system';
            }
          } else if (cleaned !== textBlock.text) {
            // Session context was stripped but no prefix found — use cleaned text
            entry.strippedText = cleaned;
          }
        }
      }

      return entry;
    }
  } catch {
    // Malformed line
  }
  return null;
}
