import { useRef, useEffect, useCallback } from 'react';
import { useAwareness } from '../hooks/useAwareness';
import { useStreamingChat } from '../hooks/useStreamingChat';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { MessageBubble } from './MessageBubble';
import { InputBar } from './InputBar';

export function ChatPane() {
  const { entries, isLoading: awarenessLoading } = useAwareness();
  const {
    messages: liveMessages,
    isStreaming,
    error,
    sendMessage,
    abortStream,
    clearError,
  } = useStreamingChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [entries, liveMessages, scrollToBottom]);

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {awarenessLoading ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Loading awareness...</p>
          </div>
        ) : entries.length === 0 && liveMessages.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Send a message to get started.</p>
          </div>
        ) : (
          <div className="chat-stream">
            {/* Historical awareness entries */}
            {entries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
            {/* Live SSE messages from current session */}
            {liveMessages.map((message) => (
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
