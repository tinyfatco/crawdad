/**
 * TerminalPane — xterm.js WebSocket PTY into the container.
 * Center panel when display_mode='terminal'.
 */

import { useEffect } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane() {
  const { containerRef, isConnected, error, reconnect } = useTerminal();

  // Refit when this component becomes visible (panel resize)
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      // The terminal auto-fits via the hook's resize handler
      window.dispatchEvent(new Event('resize'));
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [containerRef]);

  return (
    <div className="terminal-pane">
      <div className="terminal-container" ref={containerRef} />
      {!isConnected && (
        <div className="terminal-overlay">
          {error ? (
            <>
              <span className="terminal-overlay-text">{error}</span>
              <button className="terminal-reconnect-btn" onClick={reconnect}>
                Reconnect
              </button>
            </>
          ) : (
            <span className="terminal-overlay-text">Connecting...</span>
          )}
        </div>
      )}
    </div>
  );
}
