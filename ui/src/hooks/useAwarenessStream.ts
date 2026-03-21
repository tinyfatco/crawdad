/**
 * useAwarenessStream — tail-first awareness loading with lazy scroll-up.
 *
 * 1. Fetches the most recent entries via GET /awareness/backlog?limit=50
 * 2. Connects to GET /awareness/stream for live SSE updates (no backlog replay)
 * 3. Exposes loadMore() for paginated scroll-up loading of older entries
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '../api';
import { parseContextLine, type AwarenessEntry } from '../types';

export interface UseAwarenessStreamReturn {
  entries: AwarenessEntry[];
  isLoading: boolean;
  /** True once the initial backlog has been fetched */
  backlogDone: boolean;
  /** Load older entries (for scroll-up pagination) */
  loadMore: () => void;
  /** True while loading older entries */
  isLoadingMore: boolean;
  /** True when there are no more older entries to load */
  allLoaded: boolean;
  error: string | null;
}

export function useAwarenessStream(): UseAwarenessStreamReturn {
  const [entries, setEntries] = useState<AwarenessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [backlogDone, setBacklogDone] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [allLoaded, setAllLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the oldest line offset we've loaded (for pagination)
  const oldestOffsetRef = useRef<number>(Infinity);

  // Fetch initial backlog (recent entries) — retries on failure for cold starts
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const resp = await fetch(apiUrl('/awareness/backlog?limit=50'));
          if (!resp.ok) throw new Error(`${resp.status}`);
          const data = await resp.json() as { lines: string[]; total: number; offset: number };

          if (cancelled) return;

          const parsed = data.lines
            .map((line: string) => parseContextLine(line))
            .filter((e): e is AwarenessEntry => e !== null);

          oldestOffsetRef.current = data.offset;
          setEntries(parsed);
          setAllLoaded(data.offset === 0);
          setIsLoading(false);
          setBacklogDone(true);
          return;
        } catch {
          if (cancelled) return;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          // All retries exhausted
          setIsLoading(false);
          setBacklogDone(true);
          setError('Failed to load awareness history');
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Connect SSE for live updates (no backlog replay)
  useEffect(() => {
    const url = apiUrl('/awareness/stream');
    const es = new EventSource(url);

    es.onmessage = (event) => {
      const entry = parseContextLine(event.data);
      if (!entry) return;
      setEntries((prev) => [...prev, entry]);
    };

    es.onerror = () => {
      setError('Connection lost — reconnecting...');
      setTimeout(() => setError(null), 3000);
    };

    es.onopen = () => {
      setError(null);
    };

    return () => { es.close(); };
  }, []);

  // Load older entries (scroll-up pagination)
  const loadMore = useCallback(async () => {
    if (isLoadingMore || allLoaded || oldestOffsetRef.current <= 0) return;

    setIsLoadingMore(true);
    try {
      const resp = await fetch(apiUrl(`/awareness/backlog?limit=50&before=${oldestOffsetRef.current}`));
      if (!resp.ok) throw new Error(`backlog fetch failed: ${resp.status}`);
      const data = await resp.json() as { lines: string[]; total: number; offset: number };

      const parsed = data.lines
        .map((line: string) => parseContextLine(line))
        .filter((e): e is AwarenessEntry => e !== null);

      oldestOffsetRef.current = data.offset;
      if (data.offset === 0) setAllLoaded(true);

      // Prepend older entries
      setEntries((prev) => [...parsed, ...prev]);
    } catch {
      setError('Failed to load older messages');
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, allLoaded]);

  return { entries, isLoading, backlogDone, loadMore, isLoadingMore, allLoaded, error };
}
