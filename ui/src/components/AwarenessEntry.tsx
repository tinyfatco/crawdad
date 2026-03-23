import { memo, useState } from 'react';
import type { AwarenessEntry as AwarenessEntryType, ContentBlock, ToolCallContent, ToolResultContent } from '../types';
import { ChannelBadge } from './ChannelBadge';
import { Markdown } from './Markdown';

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

interface AwarenessEntryProps {
  entry: AwarenessEntryType;
}

function EventEntry({ channel, label, description, fullDescription }: {
  channel?: string;
  label: string;
  description: string;
  fullDescription?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="awareness-entry event-entry">
      <div className="event-header">
        {channel && <ChannelBadge channel={channel} />}
        <span className="event-icon">{'\u25C6'}</span>
        <span className="event-name">{label}</span>
      </div>
      {description && (
        <div
          className={`event-desc ${fullDescription ? 'expandable' : ''}`}
          onClick={fullDescription ? () => setExpanded(!expanded) : undefined}
        >
          {expanded ? fullDescription : description}
        </div>
      )}
    </div>
  );
}

/** Strip <session_context>...</session_context> blocks from text */
function stripSessionContext(text: string): string {
  return text.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, '');
}

function ToolCallBlock({ block, isRunning, result }: { block: ToolCallContent; isRunning?: boolean; result?: ToolResultContent }) {
  const [expanded, setExpanded] = useState(false);
  const args = block.arguments || {};
  const label = (args.label as string) || block.name;

  const statusIcon = isRunning
    ? <span className="tool-spinner" />
    : result?.isError
      ? <span className="tool-status-icon error">!</span>
      : <span className="tool-status-icon success">{'\u2713'}</span>;

  return (
    <div className={`tool-call ${isRunning ? 'running' : ''} ${result?.isError ? 'error' : ''}`}>
      <button className="tool-header" onClick={() => setExpanded(!expanded)}>
        {statusIcon}
        <span className="tool-arrow">{'\u2192'}</span>
        <span className="tool-label">{label}</span>
        <span className="tool-expand">{expanded ? '\u2212' : '+'}</span>
      </button>
      {expanded && (
        <div className="tool-details">
          <div className="tool-detail">
            <span className="tool-detail-label">args</span>
            <pre className="tool-detail-pre">{JSON.stringify(args, null, 2)}</pre>
          </div>
          {result?.result && (
            <div className="tool-detail">
              <span className="tool-detail-label">result</span>
              <pre className="tool-detail-pre">{result.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultBlock({ content }: { content: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;

  return (
    <div className="awareness-tool-result">
      <button className="tool-result-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="tool-result-preview">{preview}</span>
        <span className="tool-expand">{expanded ? '\u2212' : '+'}</span>
      </button>
      {expanded && <pre className="tool-detail-pre">{content}</pre>}
    </div>
  );
}

export const AwarenessEntryComponent = memo(function AwarenessEntryComponent({ entry }: AwarenessEntryProps) {
  if (entry.type === 'session') return null;
  if (!entry.content || !Array.isArray(entry.content)) return null;

  // Tool results — render collapsed
  if (entry.role === 'toolResult') {
    const results = entry.content.filter((c) => c.type === 'toolResult');
    if (results.length === 0) return null;

    return (
      <div className="awareness-entry tool-result-entry">
        {results.map((r, i) => (
          <ToolResultBlock
            key={i}
            content={'result' in r ? String(r.result) : ''}
            isError={'isError' in r ? r.isError : false}
          />
        ))}
      </div>
    );
  }

  // User messages
  if (entry.role === 'user') {
    const text = entry.strippedText || extractText(entry.content);

    // Event triggers (heartbeat, scheduled) — compact indicator
    // Formats: [EVENT:name:type:cron] [source] label  OR  [EVENT:name:type:cron] label
    const eventMatch = text.match(/^\[EVENT:([^:\]]+)[^\]]*\]\s*(?:\[([^\]]+)\]\s*)?([\s\S]*)$/);
    if (eventMatch) {
      const eventFile = eventMatch[1].replace(/\.json$/, ''); // e.g. "daily-5am-checkin"
      const eventSource = eventMatch[2]; // e.g. "heartbeat" (optional)
      const eventDesc = (eventMatch[3] || '').trim();
      const label = eventSource || eventFile;
      // Heartbeat events always show as heartbeat channel, regardless of target channelId
      const displayChannel = (eventFile === 'heartbeat' || eventSource === 'heartbeat') ? 'heartbeat' : entry.channel;
      // Truncate long descriptions to first sentence
      const shortDesc = eventDesc.length > 60 ? eventDesc.substring(0, 60) + '...' : eventDesc;
      return (
        <EventEntry
          channel={displayChannel}
          label={label}
          description={shortDesc}
          fullDescription={eventDesc.length > 60 ? eventDesc : undefined}
        />
      );
    }

    // System actions (/model, /compact, etc.) — compact inline indicator
    if (entry.isSystemAction) {
      // e.g. "/model → fireworks/minimax-m2p5" or "/compact 437 → 12 messages"
      const actionText = text.startsWith('/') ? text : text;
      const cmdMatch = actionText.match(/^(\/\w+)\s*(.*)/);
      const cmd = cmdMatch ? cmdMatch[1] : '/action';
      const detail = cmdMatch ? cmdMatch[2] : actionText;

      return (
        <div className="awareness-entry system-action-entry">
          <div className="event-header">
            {entry.timestamp && <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>}
            <span className="system-action-cmd">{cmd}</span>
            {detail && <span className="system-action-detail">{detail}</span>}
          </div>
        </div>
      );
    }

    // Ambient engagement — show as a compact trigger with conversation snippet
    if (entry.isAmbient) {
      const ambientText = text.replace(/^\[AMBIENT\]\s*/, '');
      // Extract just the conversation lines (between "Recent messages:" and "Channel pulse:")
      const convoMatch = ambientText.match(/Recent messages:\s*\n\n([\s\S]*?)\n\nChannel pulse:/);
      const convoLines = convoMatch ? convoMatch[1].trim() : '';
      const pulseMatch = ambientText.match(/Channel pulse:\s*(.*?)\.?\s*$/m);
      const pulseInfo = pulseMatch ? pulseMatch[1] : '';

      return (
        <div className="awareness-entry ambient-entry">
          <div className="event-header">
            {entry.channel && <ChannelBadge channel={entry.channel} />}
            <span className="event-icon">{'\u25C8'}</span>
            <span className="event-name">ambient</span>
            {pulseInfo && <span className="ambient-pulse">{pulseInfo}</span>}
          </div>
          {convoLines && (
            <div className="ambient-conversation">
              {convoLines.split('\n').map((line, i) => (
                <div key={i} className="ambient-line">{line}</div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="awareness-entry user-entry">
        <div className="awareness-meta">
          {entry.timestamp && <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>}
          {entry.channel && <ChannelBadge channel={entry.channel} />}
          {entry.userName && <span className="awareness-username">{(entry.channel === 'web' && (entry.userName === 'user' || entry.userName === 'web-user')) ? 'you' : entry.userName}</span>}
        </div>
        <div className="awareness-user-text">{text}</div>
      </div>
    );
  }

  // Assistant messages
  if (entry.role === 'assistant') {
    const thinkingBlocks = entry.content.filter((c) => c.type === 'thinking');
    const textBlocks = entry.content.filter((c) => c.type === 'text');
    const toolCallBlocks = entry.content.filter((c) => c.type === 'toolCall') as ToolCallContent[];
    const toolResults = entry.content.filter((c) => c.type === 'toolResult') as ToolResultContent[];
    const rawText = textBlocks.map((c) => c.type === 'text' ? c.text : '').join('').trim();
    const hasText = textBlocks.some((c) => c.type === 'text' && stripSessionContext(c.text).trim());

    const getToolResult = (tc: ToolCallContent): ToolResultContent | undefined =>
      toolResults.find((r) => r.toolCallId === tc.id);

    const isToolRunning = (tc: ToolCallContent): boolean =>
      !!entry.isStreaming && !getToolResult(tc);

    // [SILENT] responses — minimal indicator
    if (rawText === '[SILENT]') {
      return (
        <div className="awareness-entry silent-entry">
          <span className="silent-dot" />
          <span className="silent-label">silent</span>
        </div>
      );
    }

    // Skip entries that only have session_context and no other content
    if (!hasText && thinkingBlocks.length === 0 && toolCallBlocks.length === 0 && !entry.isStreaming) {
      return null;
    }

    return (
      <div className="awareness-entry assistant-entry">
        {!entry.isStreaming && entry.timestamp && (
          <div className="awareness-meta">
            <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>
          </div>
        )}
        {thinkingBlocks.map((block, i) => (
          <ThinkingBlock key={i} text={block.type === 'thinking' ? block.thinking : ''} />
        ))}
        {textBlocks.map((block, i) => {
          if (block.type !== 'text') return null;
          const cleaned = stripSessionContext(block.text);
          if (!cleaned.trim()) return null;
          return <Markdown key={i} content={cleaned} />;
        })}
        {toolCallBlocks.map((block, i) => (
          <ToolCallBlock key={i} block={block} isRunning={isToolRunning(block)} result={getToolResult(block)} />
        ))}
        {entry.isStreaming && <span className="cursor" />}
      </div>
    );
  }

  return null;
});

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;

  return (
    <div className="awareness-thinking" onClick={() => setExpanded(!expanded)}>
      <span className="thinking-icon">{'\uD83D\uDCAD'}</span>
      <span className="thinking-text">
        {expanded ? text : text.substring(0, 80) + (text.length > 80 ? '...' : '')}
      </span>
    </div>
  );
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
}
