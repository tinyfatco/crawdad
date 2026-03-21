/**
 * DesktopPane — noVNC desktop stream embedded via iframe.
 * Center panel when display_mode='desktop'.
 *
 * Fetches the stream URL from /desktop/stream-url, then renders an iframe
 * pointing at the noVNC HTML client with autoconnect + resize=scale.
 */

import { useState, useEffect } from 'react';
import { apiUrl } from '../api';

export function DesktopPane() {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'starting' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // First check desktop status
        const statusResp = await fetch(apiUrl('/desktop/status'));
        if (!statusResp.ok) {
          // Desktop not started yet — try to start it
          setStatus('starting');
          const startResp = await fetch(apiUrl('/desktop/start'), { method: 'POST' });
          if (!startResp.ok) {
            throw new Error('Failed to start desktop');
          }
          // Wait a moment for Xvfb + x11vnc to initialize
          await new Promise((r) => setTimeout(r, 2000));
        }

        // Get the noVNC stream URL
        const urlResp = await fetch(apiUrl('/desktop/stream-url'));
        if (!urlResp.ok) throw new Error('Failed to get stream URL');
        const data = await urlResp.json();

        if (!cancelled) {
          // The stream URL comes from the CF sandbox API — it points to a
          // port-based subdomain on crawdad.tinyfat.com. But we want to proxy
          // through our own authenticated path. Build a relative VNC URL.
          const base = window.location.pathname.endsWith('/')
            ? window.location.pathname.slice(0, -1)
            : window.location.pathname;
          const vncUrl = `${base}/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000`;
          setStreamUrl(vncUrl);
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
  }, []);

  if (status === 'error') {
    return (
      <div className="desktop-pane">
        <div className="desktop-placeholder">
          <span className="desktop-placeholder-icon">&#x26A0;</span>
          <span className="desktop-placeholder-text">{error || 'Desktop error'}</span>
          <button
            className="terminal-reconnect-btn"
            onClick={() => { setStatus('loading'); setError(null); }}
            style={{ marginTop: 8 }}
          >
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
