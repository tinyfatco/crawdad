/**
 * useTerminal — WebSocket PTY connection to the container terminal.
 *
 * Connects to /terminal via WebSocket (cookie auth, no token needed).
 * Returns a ref to attach xterm.js and connection state.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export interface UseTerminalReturn {
  /** Ref to attach to the terminal container div */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the WebSocket is connected */
  isConnected: boolean;
  /** Connection error message */
  error: string | null;
  /** Reconnect manually */
  reconnect: () => void;
}

function getTerminalWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // Base path: /agents/{id}/ — terminal endpoint is /agents/{id}/terminal
  const base = loc.pathname.endsWith('/') ? loc.pathname.slice(0, -1) : loc.pathname;
  return `${proto}//${loc.host}${base}/terminal`;
}

const textEncoder = new TextEncoder();

export function useTerminal(): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!containerRef.current || !mountedRef.current) return;

    // Create terminal if not exists
    if (!terminalRef.current) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"SF Mono", Monaco, "Cascadia Code", "Courier New", monospace',
        theme: {
          background: '#1a1a1a',
          foreground: '#dddddd',
          cursor: '#4a9eff',
          selectionBackground: 'rgba(74, 158, 255, 0.3)',
          black: '#0a0a0a',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#f59e0b',
          blue: '#4a9eff',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#e8e8e6',
          brightBlack: '#71716e',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#fbbf24',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#ffffff',
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current);
      fitAddon.fit();

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
    }

    const term = terminalRef.current;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setError(null);

    const wsUrl = getTerminalWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
      setError(null);

      // Send initial resize
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        const dims = fitAddonRef.current.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else if (typeof event.data === 'string') {
        // Text messages are JSON control messages from the sandbox PTY — don't render them
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ready') {
            // Navigate to /data on connect and clear the screen
            ws.send(textEncoder.encode('cd /data 2>/dev/null; clear\n'));
          }
        } catch {
          // Not JSON — write as text fallback
          term.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      // Auto-reconnect after 3s
      reconnectTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('Terminal connection failed');
      setIsConnected(false);
    };

    // Terminal input → WebSocket (binary so server distinguishes from JSON control messages)
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(textEncoder.encode(data));
      }
    });

    // Terminal resize → WebSocket
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
  }, []);

  const reconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    // Handle window resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('resize', handleResize);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
    };
  }, [connect]);

  return { containerRef, isConnected, error, reconnect };
}
