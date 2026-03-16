import { useState } from 'react';
import type { ToolCall } from '../hooks/useStreamingChat';

interface ToolCallDisplayProps {
  toolCall: ToolCall;
}

function getToolSummary(name: string, args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const toolName = name.toLowerCase();

  switch (toolName) {
    case 'read':
    case 'edit':
    case 'write': {
      const path = args.file_path || args.notebook_path;
      if (typeof path === 'string') return path.split('/').pop() || null;
      return null;
    }
    case 'glob':
      return typeof args.pattern === 'string'
        ? args.pattern.length > 30 ? args.pattern.slice(0, 30) + '...' : args.pattern
        : null;
    case 'grep':
      return typeof args.pattern === 'string'
        ? `"${args.pattern.length > 25 ? args.pattern.slice(0, 25) + '...' : args.pattern}"`
        : null;
    case 'bash':
      return typeof args.command === 'string'
        ? args.command.trim().length > 35 ? args.command.trim().slice(0, 35) + '...' : args.command.trim()
        : null;
    default:
      return null;
  }
}

function renderToolDetails(toolCall: ToolCall) {
  const { name, args, resultPreview } = toolCall;
  const toolName = name.toLowerCase();

  if ((toolName === 'read' || toolName === 'write' || toolName === 'edit') && args) {
    const filePath = (args.file_path || args.notebook_path) as string | undefined;
    return (
      <>
        {filePath && <Detail label="file" content={filePath} />}
        {toolName === 'edit' && typeof args.old_string === 'string' && (
          <Detail label="old" content={truncate(args.old_string as string, 300)} />
        )}
        {toolName === 'edit' && typeof args.new_string === 'string' && (
          <Detail label="new" content={truncate(args.new_string as string, 300)} />
        )}
        {resultPreview && <Detail label="result" content={resultPreview} />}
      </>
    );
  }

  if (toolName === 'bash' && args) {
    return (
      <>
        {typeof args.command === 'string' && <Detail label="command" content={args.command as string} />}
        {resultPreview && <Detail label="output" content={resultPreview} />}
      </>
    );
  }

  if ((toolName === 'grep' || toolName === 'glob') && args) {
    return (
      <>
        {typeof args.pattern === 'string' && <Detail label="pattern" content={args.pattern as string} />}
        {typeof args.path === 'string' && <Detail label="path" content={args.path as string} />}
        {resultPreview && <Detail label="matches" content={resultPreview} />}
      </>
    );
  }

  return (
    <>
      {args && Object.keys(args).length > 0 && <Detail label="args" content={JSON.stringify(args, null, 2)} />}
      {resultPreview && <Detail label="result" content={resultPreview} />}
    </>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n...' : s;
}

function Detail({ label, content }: { label: string; content: string }) {
  return (
    <div className="tool-detail">
      <span className="tool-detail-label">{label}</span>
      <pre className="tool-detail-pre">{content}</pre>
    </div>
  );
}

export function ToolCallDisplay({ toolCall }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = toolCall.args || toolCall.resultPreview;
  const summary = getToolSummary(toolCall.name, toolCall.args);

  const statusIcon = toolCall.isRunning
    ? <span className="tool-spinner" />
    : toolCall.isError
      ? <span className="tool-status-icon error">!</span>
      : <span className="tool-status-icon success">-</span>;

  return (
    <div className={`tool-call ${toolCall.isRunning ? 'running' : ''} ${toolCall.isError ? 'error' : ''}`}>
      <button
        className="tool-header"
        onClick={() => hasDetails && setExpanded(!expanded)}
        disabled={!hasDetails}
      >
        {statusIcon}
        <span className="tool-name">{toolCall.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {hasDetails && <span className="tool-expand">{expanded ? '-' : '+'}</span>}
      </button>

      {expanded && hasDetails && (
        <div className="tool-details">
          {renderToolDetails(toolCall)}
        </div>
      )}
    </div>
  );
}
