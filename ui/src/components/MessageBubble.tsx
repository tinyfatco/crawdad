import { memo } from 'react';
import type { Message } from '../hooks/useStreamingChat';
import { ToolCallDisplay } from './ToolCallDisplay';
import { Markdown } from './Markdown';

interface MessageBubbleProps {
  message: Message;
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const userText = isUser
    ? message.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('')
    : '';

  const hasTextContent = !isUser && message.blocks.some((b) => b.type === 'text' && b.text);

  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      {isUser ? (
        <div className="user-content">
          <span className="user-label">you</span>
          <span className="user-text">{userText}</span>
        </div>
      ) : (
        <div className="assistant-content">
          {message.blocks.map((block, i) => {
            if (block.type === 'text') {
              return block.text ? <Markdown key={i} content={block.text} /> : null;
            } else if (block.type === 'tool') {
              return <ToolCallDisplay key={i} toolCall={block.toolCall} />;
            }
            return null;
          })}

          {message.isStreaming && !hasTextContent && <span className="cursor" />}
          {message.isStreaming && hasTextContent && <span className="cursor" />}
        </div>
      )}
    </div>
  );
});
