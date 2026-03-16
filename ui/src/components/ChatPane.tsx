import { useRef, useEffect, useCallback } from 'react';
import { useStreamingChat } from '../hooks/useStreamingChat';
import { MessageBubble } from './MessageBubble';
import { InputBar } from './InputBar';

export function ChatPane() {
  const {
    messages,
    isStreaming,
    status,
    error,
    sendMessage,
    abortStream,
    clearError,
  } = useStreamingChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Send a message to get started.</p>
          </div>
        ) : (
          <div className="chat-stream">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="error-banner" onClick={clearError}>
          <span className="error-text">{error}</span>
          <span className="error-dismiss">&times;</span>
        </div>
      )}

      <InputBar
        onSend={sendMessage}
        onStop={abortStream}
        disabled={isStreaming}
        isStreaming={isStreaming}
      />
    </div>
  );
}
