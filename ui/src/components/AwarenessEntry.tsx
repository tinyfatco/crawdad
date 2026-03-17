import { memo, useState } from 'react';
import type { AwarenessEntry as AwarenessEntryType, ContentBlock, ToolCallContent, ToolResultContent } from '../types';
import { ChannelBadge } from './ChannelBadge';
import { Markdown } from './Markdown';

interface AwarenessEntryProps {
  entry: AwarenessEntryType;
}

function ToolCallBlock({ block, isRunning, result }: { block: ToolCallContent; isRunning?: boolean; result?: ToolResultContent }) {
  const [expanded, setExpanded] = useState(false);
  const args = block.arguments || {};
  const summary = args.command
    ? String(args.command).substring(0, 50)
    : args.file_path
      ? String(args.file_path).split('/').pop()
      : args.pattern
        ? String(args.pattern)
        : null;

  const statusIcon = isRunning
    ? <span className="tool-spinner" />
    : result?.isError
      ? <span className="tool-status-icon error">!</span>
      : <span className="tool-status-icon success">-</span>;

  return (
    <div className={`tool-call ${isRunning ? 'running' : ''} ${result?.isError ? 'error' : ''}`}>
      <button className="tool-header" onClick={() => setExpanded(!expanded)}>
        {statusIcon}
        <span className="tool-name">{block.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-expand">{expanded ? '-' : '+'}</span>
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
        <span className="tool-expand">{expanded ? '-' : '+'}</span>
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
    return (
      <div className="awareness-entry user-entry">
        <div className="awareness-meta">
          {entry.channel && <ChannelBadge channel={entry.channel} />}
          {entry.userName && <span className="awareness-username">{(entry.channel === 'web' && (entry.userName === 'user' || entry.userName === 'web-user')) ? 'you' : entry.userName}</span>}
        </div>
        <div className="awareness-user-text">{entry.strippedText || extractText(entry.content)}</div>
      </div>
    );
  }

  // Assistant messages
  if (entry.role === 'assistant') {
    const thinkingBlocks = entry.content.filter((c) => c.type === 'thinking');
    const textBlocks = entry.content.filter((c) => c.type === 'text');
    const toolCallBlocks = entry.content.filter((c) => c.type === 'toolCall') as ToolCallContent[];
    const toolResults = entry.content.filter((c) => c.type === 'toolResult') as ToolResultContent[];
    const hasText = textBlocks.some((c) => c.type === 'text' && c.text.trim());

    // Match tool calls to their results
    const getToolResult = (tc: ToolCallContent): ToolResultContent | undefined =>
      toolResults.find((r) => r.toolCallId === tc.id);

    // A tool is "running" if: entry is streaming AND the tool has no result yet
    const isToolRunning = (tc: ToolCallContent): boolean =>
      !!entry.isStreaming && !getToolResult(tc);

    return (
      <div className="awareness-entry assistant-entry">
        {thinkingBlocks.map((block, i) => (
          <ThinkingBlock key={i} text={block.type === 'thinking' ? block.thinking : ''} />
        ))}
        {textBlocks.map((block, i) =>
          block.type === 'text' && block.text.trim() ? (
            <Markdown key={i} content={block.text} />
          ) : null,
        )}
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
      <span className="thinking-icon">{expanded ? '\u25BE' : '\u25B8'}</span>
      <span className="thinking-text">
        {expanded ? text : text.substring(0, 60) + (text.length > 60 ? '...' : '')}
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
