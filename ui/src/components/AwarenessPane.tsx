/**
 * AwarenessPane — right sidebar showing the unified awareness stream + chat input.
 * Shows all channel activity (Telegram, Slack, email, web, heartbeat) in real time.
 *
 * Loads recent entries first (tail-first), lazy-loads older entries on scroll-up.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
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

  const error = chatError || streamError;

  // Dedup: when optimistic entries exist, skip SSE entries that duplicate them.
  // The optimistic entries (userEntry, streamingEntry) are the source of truth
  // for the current turn — SSE duplicates get filtered out at render time.
  const lastUserText = userEntry?.strippedText || '';
  const filteredEntries = (lastUserText || streamingEntry)
    ? entries.filter((e) => {
        // Skip SSE user entry that matches the optimistic one
        if (lastUserText && e.role === 'user' && e.strippedText === lastUserText) return false;
        // Skip SSE assistant entry that follows the matched user entry (same turn)
        if (streamingEntry && e.role === 'assistant' && lastUserText) {
          // Check if the previous entry in the original array was the matched user
          const idx = entries.indexOf(e);
          if (idx > 0 && entries[idx - 1]?.role === 'user' && entries[idx - 1]?.strippedText === lastUserText) return false;
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
      <div className="awareness-pane-header">
        <span className="awareness-pane-title">Awareness</span>
      </div>

      <div
        className="awareness-pane-messages"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {isLoading ? (
          <div className="awareness-pane-empty">
            <span>Loading...</span>
          </div>
        ) : filteredEntries.length === 0 && !userEntry && !streamingEntry ? (
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
            {!allLoaded && !isLoadingMore && filteredEntries.length > 0 && (
              <div className="awareness-loading-more awareness-load-trigger">
                <span>Scroll up for older messages</span>
              </div>
            )}
            {filteredEntries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
            {userEntry && <AwarenessEntryComponent key={userEntry.id} entry={userEntry} />}
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

      <InputBar
        onSend={sendMessage}
        onStop={abortStream}
        disabled={isStreaming}
        isStreaming={isStreaming}
      />
    </div>
  );
}
