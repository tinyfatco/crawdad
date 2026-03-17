import { useRef, useEffect, useCallback } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';

export function ChatPane() {
  const {
    entries,
    isLoading,
    isStreaming,
    error,
    sendMessage,
    abortStream,
    clearError,
  } = useAwarenessStream();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [entries, scrollToBottom]);

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {isLoading ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Loading awareness...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Send a message to get started.</p>
          </div>
        ) : (
          <div className="chat-stream">
            {entries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
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
