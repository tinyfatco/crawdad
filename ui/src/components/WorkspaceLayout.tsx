import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatPane } from './ChatPane';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';

export function WorkspaceLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const handleFileSelect = (path: string) => {
    setSelectedPath(path);
    setViewingFile(path);
    setMobileDrawerOpen(false);
  };

  const toggleSidebar = () => {
    // Check CSS media query instead of window.innerWidth for reliable mobile detection
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      setMobileDrawerOpen(!mobileDrawerOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const toggleTheme = () => {
    const newDark = !isDark;
    document.documentElement.classList.toggle('dark', newDark);
    localStorage.setItem('theme', newDark ? 'dark' : 'light');
    setIsDark(newDark);
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSidebarWidth(Math.max(180, Math.min(400, e.clientX - rect.left)));
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div className="workspace-root">
      <header className="workspace-header">
        <div className="header-left">
          <button
            className="header-btn"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Show files' : 'Hide files'}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <span className="header-title">Troublemaker</span>
        </div>
        <div className="header-right">
          <button className="header-btn" onClick={toggleTheme} title="Toggle theme">
            {isDark ? '\u2600' : '\u263D'}
          </button>
        </div>
      </header>

      <div className="workspace-body" ref={containerRef}>
        {!sidebarCollapsed && (
          <>
            <div className="sidebar-panel" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span className="sidebar-title">Files</span>
              </div>
              <FileTree selectedPath={selectedPath} onFileSelect={handleFileSelect} />
            </div>
            <div className="resize-handle" onMouseDown={handleMouseDown} />
          </>
        )}

        <div className="main-panel">
          {viewingFile ? (
            <FileViewer path={viewingFile} onClose={() => setViewingFile(null)} />
          ) : (
            <ChatPane />
          )}
        </div>

        {/* Mobile drawer overlay */}
        {mobileDrawerOpen && (
          <>
            <div className="mobile-overlay" onClick={() => setMobileDrawerOpen(false)} />
            <div className="mobile-drawer">
              <div className="sidebar-header">
                <span className="sidebar-title">Files</span>
              </div>
              <FileTree selectedPath={selectedPath} onFileSelect={handleFileSelect} />
            </div>
          </>
        )}
      </div>

      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .workspace-root {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    overflow: hidden;
  }

  /* Header */
  .workspace-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 12px;
    height: 44px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface);
  }

  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: none;
    border: none;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
  }

  .header-btn:hover { background: var(--bg-secondary); color: var(--text); }

  /* Body */
  .workspace-body {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  /* Sidebar */
  .sidebar-panel {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-right: 1px solid var(--border);
    height: 100%;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 10px 12px 6px;
    flex-shrink: 0;
  }

  .sidebar-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  /* Resize handle */
  .resize-handle {
    width: 4px;
    background: var(--border);
    cursor: col-resize;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .resize-handle:hover { background: var(--accent); }

  /* Main panel */
  .main-panel {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    overflow: hidden;
  }

  /* Chat pane */
  .chat-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-width: 720px;
    margin: 0 auto;
    width: 100%;
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  .chat-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
  }

  .chat-empty-text { font-size: 0.9rem; }

  .chat-stream {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* Messages */
  .message { max-width: 100%; }
  .message.user { display: flex; justify-content: flex-end; }

  .user-content {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    max-width: 85%;
  }

  .user-label {
    font-size: 0.65rem;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    opacity: 0.6;
  }

  .user-text {
    color: var(--text);
    font-size: 0.95rem;
    line-height: 1.5;
    text-align: right;
  }

  .assistant-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--text);
    line-height: 1.7;
    font-size: 1rem;
  }

  .assistant-content .markdown-content p { margin-bottom: 0.5rem; }
  .assistant-content .markdown-content p:last-child { margin-bottom: 0; }

  .assistant-content code {
    background: var(--bg-secondary);
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.85em;
  }

  .assistant-content pre {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.5rem 0;
    border: 1px solid var(--border);
  }

  .assistant-content pre code {
    background: none;
    padding: 0;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .assistant-content ul, .assistant-content ol { margin: 0.5rem 0; padding-left: 1.5rem; }
  .assistant-content li { margin-bottom: 0.25rem; }

  .assistant-content h1, .assistant-content h2, .assistant-content h3 {
    font-weight: 600;
    margin-top: 0.25rem;
    margin-bottom: 0.25rem;
  }

  .assistant-content h1 { font-size: 1.25rem; }
  .assistant-content h2 { font-size: 1.1rem; }
  .assistant-content h3 { font-size: 1rem; }

  /* Cursor */
  .cursor {
    display: inline-block;
    width: 2px;
    height: 1.1em;
    background: var(--accent);
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: cursor-blink 0.8s ease-in-out infinite;
  }

  @keyframes cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* Tool calls */
  .tool-call {
    font-size: 0.8rem;
    font-family: var(--font-mono);
    border-left: 2px solid var(--border);
    background: var(--bg-secondary);
    border-radius: 0 4px 4px 0;
    margin: 0.25rem 0;
  }

  .tool-call.running { border-left-color: var(--accent); background: var(--accent-muted); }
  .tool-call.error { border-left-color: var(--error); background: rgba(239, 68, 68, 0.05); }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: none;
    border: none;
    color: var(--text-muted);
    text-align: left;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }

  .tool-header:disabled { cursor: default; }
  .tool-header:hover:not(:disabled) { color: var(--text); }

  .tool-status-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .tool-status-icon.success { color: var(--success); }
  .tool-status-icon.error { color: var(--error); }

  .tool-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .tool-name { flex-shrink: 0; }
  .tool-summary { flex: 1; opacity: 0.7; font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-expand { opacity: 0.5; font-size: 0.9rem; }

  .tool-details { padding: 0 0.6rem 0.5rem; font-size: 0.75rem; }

  .tool-detail { margin-top: 0.5rem; }

  .tool-detail-label {
    display: block;
    color: var(--text-muted);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }

  .tool-detail-pre {
    margin: 0;
    padding: 0.5rem;
    background: var(--bg);
    border-radius: 3px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 150px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text);
  }

  /* Input bar */
  .input-bar {
    padding: 0.75rem 1rem 1rem;
    width: 100%;
  }

  .input-container {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: var(--bg-secondary);
    padding: 0.5rem;
    transition: border-color 0.15s;
  }

  .input-container:focus-within { border-color: var(--accent); }

  .input-bar textarea {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: 1.5;
    resize: none;
    min-height: 36px;
    max-height: 180px;
  }

  .input-bar textarea:focus { outline: none; }
  .input-bar textarea::placeholder { color: var(--text-muted); }
  .input-bar textarea:disabled { opacity: 0.5; cursor: not-allowed; }

  .send-button, .control-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .send-button {
    background: var(--accent);
    color: white;
  }

  .send-button:hover:not(:disabled) { opacity: 0.9; }
  .send-button:disabled { opacity: 0.4; cursor: not-allowed; }
  .send-button svg, .control-button svg { width: 18px; height: 18px; }

  .control-button.stop { background: var(--error); color: white; }
  .control-button.stop:hover { opacity: 0.9; }

  /* Error banner */
  .error-banner {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: var(--error);
    padding: 0.6rem 0.875rem;
    margin: 0 1rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
  }

  .error-text { flex: 1; font-family: var(--font-mono); }
  .error-dismiss { font-size: 1rem; opacity: 0.6; margin-left: 0.5rem; }
  .error-banner:hover .error-dismiss { opacity: 1; }

  /* File tree */
  .file-tree {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    font-size: 13px;
  }

  .file-tree-status {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    color: var(--text-muted);
    font-size: 12px;
  }

  .file-tree-status.error { color: var(--error); }

  .tree-node {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding-right: 8px;
    cursor: pointer;
    border-radius: 4px;
    margin: 0 4px;
    color: var(--text-muted);
  }

  .tree-node:hover { background: rgba(255, 255, 255, 0.05); color: var(--text); }
  .dark .tree-node:hover { background: rgba(255, 255, 255, 0.05); }
  .tree-node.selected { background: var(--accent-muted); color: var(--accent); }

  .expand-icon {
    width: 14px;
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
    flex-shrink: 0;
  }

  .file-icon { font-size: 13px; flex-shrink: 0; }

  .file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .empty-dir {
    color: var(--text-muted);
    font-size: 12px;
    font-style: italic;
    padding: 8px 12px;
    opacity: 0.5;
  }

  /* File viewer */
  .file-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .file-viewer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface);
  }

  .file-viewer-path {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-viewer-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    line-height: 1;
  }

  .file-viewer-close:hover { background: var(--bg-secondary); color: var(--text); }

  .file-viewer-content {
    flex: 1;
    overflow: auto;
    padding: 0;
  }

  .file-viewer-status {
    padding: 20px;
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
  }

  .file-viewer-status.error { color: var(--error); }

  .file-viewer-pre {
    margin: 0;
    padding: 16px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* Awareness entries */
  .awareness-entry {
    max-width: 100%;
  }

  .awareness-entry.user-entry {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .awareness-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
  }

  .channel-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
    border: 1px solid;
  }

  .awareness-username {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .awareness-user-text {
    color: var(--text);
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .awareness-entry.assistant-entry {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--text);
    line-height: 1.7;
    font-size: 0.75rem;
    margin-left: 0.25rem;
  }

  .awareness-entry.assistant-entry .markdown-content p { margin-bottom: 0.5rem; }
  .awareness-entry.assistant-entry .markdown-content p:last-child { margin-bottom: 0; }

  .awareness-thinking {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
    cursor: pointer;
    padding: 0.3rem 0;
  }

  .awareness-thinking:hover { color: var(--text); }

  .thinking-icon {
    font-size: 0.65rem;
    margin-top: 0.15rem;
    flex-shrink: 0;
  }

  .thinking-text {
    line-height: 1.4;
  }

  .awareness-tool-result {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .tool-result-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.3rem 0.5rem;
    background: var(--bg-secondary);
    border: none;
    border-radius: 3px;
    color: var(--text-muted);
    text-align: left;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .tool-result-toggle:hover { color: var(--text); }

  .tool-result-preview {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-result-entry {
    margin: 0.15rem 0;
  }

  /* Mobile drawer */
  .mobile-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 40;
  }

  .mobile-drawer {
    position: fixed;
    top: 44px;
    left: 0;
    bottom: 0;
    width: 280px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    z-index: 50;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slide-in 0.15s ease-out;
  }

  @keyframes slide-in {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }

  /* Responsive */
  @media (max-width: 768px) {
    .sidebar-panel { display: none; }
    .resize-handle { display: none; }
    .chat-pane { max-width: 100%; }
  }
`;
