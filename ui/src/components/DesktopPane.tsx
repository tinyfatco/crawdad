/**
 * DesktopPane — noVNC desktop stream embedded via iframe.
 * Center panel when display_mode='desktop'.
 *
 * Fetches the stream URL from /desktop/stream-url, then renders an iframe
 * pointing at the noVNC HTML client with autoconnect + resize=scale.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';

export function DesktopPane() {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'starting' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
    setStreamUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Check desktop status — retry up to 5 times during cold start
        let desktopReady = false;
        for (let i = 0; i < 5; i++) {
          const statusResp = await fetch(apiUrl('/desktop/status'));
          if (statusResp.ok) {
            const statusData = await statusResp.json();
            if (statusData.status === 'active') {
              desktopReady = true;
              break;
            }
          }

          if (i === 0 && !cancelled) setStatus('starting');

          // Try to start it
          try {
            await fetch(apiUrl('/desktop/start'), { method: 'POST' });
          } catch {
            // Ignore start errors during retry
          }
          await new Promise((r) => setTimeout(r, 3000));
          if (cancelled) return;
        }

        if (!desktopReady && !cancelled) {
          throw new Error('Desktop did not start after retries');
        }

        // Get the noVNC stream URL
        const urlResp = await fetch(apiUrl('/desktop/stream-url'));
        if (!urlResp.ok) throw new Error('Failed to get stream URL');
        const data = await urlResp.json();

        if (!cancelled) {
          setStreamUrl(data.url);
          setStatus('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to connect to desktop');
          setStatus('error');
        }
      }
    }

    init();
    return () => { cancelled = true; };
  }, [attempt]);

  if (status === 'error') {
    return (
      <div className="desktop-pane">
        <div className="desktop-placeholder">
          <span className="desktop-placeholder-icon">&#x26A0;</span>
          <span className="desktop-placeholder-text">{error || 'Desktop error'}</span>
          <button className="terminal-reconnect-btn" onClick={retry} style={{ marginTop: 8 }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (status === 'loading' || status === 'starting') {
    return (
      <div className="desktop-pane">
        <div className="desktop-placeholder">
          <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
          <span className="desktop-placeholder-text">
            {status === 'starting' ? 'Starting desktop...' : 'Connecting...'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-pane">
      {streamUrl && (
        <iframe
          className="desktop-iframe"
          src={streamUrl}
          title="Desktop"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
