/**
 * useAwarenessStream — subscribes to the server-side awareness SSE stream.
 *
 * Connects to GET /awareness/stream on mount. The server sends the full
 * context.jsonl backlog as events, then pushes new lines as they're written
 * (from any channel — Telegram, Slack, web, email, heartbeat).
 *
 * State is append-only. No polling, no merge, no ID tracking.
 */

import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import { parseContextLine, type AwarenessEntry } from '../types';

export interface UseAwarenessStreamReturn {
  entries: AwarenessEntry[];
  isLoading: boolean;
  /** True once the initial backlog has been fully flushed */
  backlogDone: boolean;
  error: string | null;
}

export function useAwarenessStream(): UseAwarenessStreamReturn {
  const [entries, setEntries] = useState<AwarenessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [backlogDone, setBacklogDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backlogDoneRef = useRef(false);

  useEffect(() => {
    const url = apiUrl('/awareness/stream');
    const es = new EventSource(url);

    // Buffer backlog entries to avoid N individual setEntries calls
    let backlogBuffer: AwarenessEntry[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBacklog = () => {
      if (backlogBuffer.length > 0) {
        const batch = backlogBuffer;
        backlogBuffer = [];
        setEntries((prev) => [...prev, ...batch]);
      }
      setIsLoading(false);
      backlogDoneRef.current = true;
      setBacklogDone(true);
    };

    es.onmessage = (event) => {
      const entry = parseContextLine(event.data);
      if (!entry) return;

      if (!backlogDoneRef.current) {
        // During backlog phase: buffer and flush in one batch
        backlogBuffer.push(entry);
        if (flushTimer) clearTimeout(flushTimer);
        // Flush after 50ms of no new messages (end of backlog burst)
        flushTimer = setTimeout(flushBacklog, 50);
      } else {
        // After backlog: append individually (real-time updates)
        setEntries((prev) => [...prev, entry]);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects. On first error, mark backlog done
      if (!backlogDoneRef.current) {
        flushBacklog();
      }
      setError('Connection lost — reconnecting...');
      setTimeout(() => setError(null), 3000);
    };

    es.onopen = () => {
      setError(null);
    };

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      es.close();
    };
  }, []);

  return { entries, isLoading, backlogDone, error };
}
