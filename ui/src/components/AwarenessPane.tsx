/**
 * AwarenessPane — right sidebar showing the unified awareness stream + chat input.
 * Shows all channel activity (Telegram, Slack, email, web, heartbeat) in real time.
 *
 * Loads recent entries first (tail-first), lazy-loads older entries on scroll-up.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';

export function AwarenessPane() {
  const { entries, isLoading, backlogDone, loadMore, isLoadingMore, allLoaded, error: streamError } = useAwarenessStream();
  const {
    userEntry,
    streamingEntry,
    isStreaming,
    error: chatError,
    sendMessage,
    abortStream,
    clearError,
  } = useWebChat();

  const voice = useVoiceChat();
  const isVoiceActive = voice.state !== 'idle' && voice.state !== 'error';

  const error = chatError || streamError || voice.error;

  // streamingEntry is the live/completed version of the current turn's assistant
  // response. When it exists and is done (isStreaming=false), suppress the SSE
  // duplicate that arrives from context.jsonl so there's no flash.
  const streamingDone = streamingEntry && !streamingEntry.isStreaming;
  const displayEntries = streamingDone
    ? entries.filter((e) => {
        // Skip the SSE assistant entry for the current turn — streamingEntry covers it
        if (e.role === 'assistant') {
          const idx = entries.indexOf(e);
          // It's the last assistant entry, and it arrived after our user message
          if (idx === entries.length - 1) return false;
        }
        return true;
      })
    : entries;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const userScrolledRef = useRef(false);
  const prevScrollHeightRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    // Use requestAnimationFrame to ensure DOM has settled
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior });
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    });
  }, []);

  // Scroll to bottom when initial backlog loads
  useEffect(() => {
    if (backlogDone && entries.length > 0) {
      scrollToBottom('instant');
    }
  }, [backlogDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // After loading more (prepend), preserve scroll position
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !isLoadingMore) return;

    // Snapshot scrollHeight before the prepend renders
    prevScrollHeightRef.current = el.scrollHeight;
  }, [isLoadingMore]);

  // After prepend completes, adjust scroll to maintain position
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || isLoadingMore || prevScrollHeightRef.current === 0) return;

    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) {
      el.scrollTop += delta;
    }
    prevScrollHeightRef.current = 0;
  }, [entries.length, isLoadingMore]);

  // Auto-scroll on new entries (only if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrolledRef.current && backlogDone) {
      scrollToBottom('smooth');
    }
  }, [entries.length, streamingEntry, scrollToBottom, backlogDone]);

  // Detect user scroll — scroll-up triggers loadMore, scroll-down hides button
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 100) {
      userScrolledRef.current = true;
      setShowScrollBtn(true);
    } else {
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    }

    // Load more when scrolled near the top
    if (el.scrollTop < 200 && !isLoadingMore && !allLoaded && backlogDone) {
      loadMore();
    }
  }, [loadMore, isLoadingMore, allLoaded, backlogDone]);

  return (
    <div className="awareness-pane">
      <div
        className="awareness-pane-messages"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {isLoading ? (
          <div className="awareness-pane-empty">
            <span>Loading...</span>
          </div>
        ) : displayEntries.length === 0 && !streamingEntry ? (
          <div className="awareness-pane-empty">
            <span>Send a message to get started.</span>
          </div>
        ) : (
          <div className="awareness-pane-stream">
            {isLoadingMore && (
              <div className="awareness-loading-more">
                <span className="tool-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                <span>Loading older messages...</span>
              </div>
            )}
            {!allLoaded && !isLoadingMore && displayEntries.length > 0 && (
              <div className="awareness-loading-more awareness-load-trigger">
                <span>Scroll up for older messages</span>
              </div>
            )}
            {displayEntries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
            {streamingEntry && <AwarenessEntryComponent key={streamingEntry.id} entry={streamingEntry} />}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" onClick={() => scrollToBottom('smooth')}>
          &#x2193;
        </button>
      )}

      {error && (
        <div className="error-banner" onClick={clearError}>
          <span className="error-text">{error}</span>
          <span className="error-dismiss">&times;</span>
        </div>
      )}

      {isVoiceActive && (
        <div className="voice-status">
          <span className="voice-status-text">
            {voice.state === 'connecting' && 'Connecting...'}
            {voice.state === 'listening' && (voice.partial || 'Listening...')}
            {voice.state === 'thinking' && (voice.transcript || 'Thinking...')}
            {voice.state === 'speaking' && 'Speaking...'}
          </span>
        </div>
      )}

      <InputBar
        onSend={sendMessage}
        onStop={abortStream}
        disabled={isStreaming || isVoiceActive}
        isStreaming={isStreaming}
        extraButtons={
          <button
            className={`mic-button ${isVoiceActive ? 'active' : ''}`}
            onClick={isVoiceActive ? voice.stop : voice.start}
            title={isVoiceActive ? 'Stop voice' : 'Start voice'}
          >
            {isVoiceActive ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="4" y="4" width="10" height="10" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="7" y="2" width="4" height="9" rx="2" fill="currentColor" />
                <path d="M4 8.5a5 5 0 0010 0" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <path d="M9 14v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </button>
        }
      />
    </div>
  );
}
