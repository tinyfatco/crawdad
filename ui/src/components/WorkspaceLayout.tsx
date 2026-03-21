/**
 * WorkspaceLayout — three-panel IDE-like workspace.
 *
 * Left:   File explorer (collapsible)
 * Center: Terminal (default) or Desktop (if display_mode='desktop')
 *         or FileViewer when a file is selected
 * Right:  Awareness stream + chat input
 *
 * Panels are resizable via drag handles.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useConfig } from '../hooks/useConfig';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { TerminalPane } from './TerminalPane';
import { DesktopPane } from './DesktopPane';
import { AwarenessPane } from './AwarenessPane';

export function WorkspaceLayout() {
  const { config, isLoading: configLoading } = useConfig();
  const [displayOverride, setDisplayOverride] = useState<'terminal' | 'desktop' | null>(null);
  const displayMode = displayOverride ?? config.display_mode;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [awarenessCollapsed, setAwarenessCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [awarenessWidth, setAwarenessWidth] = useState(360);

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'sidebar' | 'awareness' | null>(null);

  const handleFileSelect = (path: string) => {
    setSelectedPath(path);
    setViewingFile(path);
    setMobileDrawerOpen(false);
  };

  const closeFileViewer = () => {
    setViewingFile(null);
  };

  const toggleSidebar = () => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      setMobileDrawerOpen(!mobileDrawerOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const toggleAwareness = () => {
    setAwarenessCollapsed(!awarenessCollapsed);
  };

  // Drag resize handlers
  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = 'sidebar';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleAwarenessDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = 'awareness';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === 'sidebar') {
        setSidebarWidth(Math.max(160, Math.min(400, e.clientX - rect.left)));
      } else if (draggingRef.current === 'awareness') {
        setAwarenessWidth(Math.max(280, Math.min(600, rect.right - e.clientX)));
      }
    };

    const handleMouseUp = () => {
      draggingRef.current = null;
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

  const toggleDisplayMode = () => {
    const next = displayMode === 'terminal' ? 'desktop' : 'terminal';
    setDisplayOverride(next);
  };

  const CenterPanel = () => {
    if (viewingFile) {
      return <FileViewer path={viewingFile} onClose={closeFileViewer} />;
    }
    if (configLoading && !displayOverride) {
      return (
        <div className="desktop-pane">
          <div className="desktop-placeholder">
            <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
          </div>
        </div>
      );
    }
    if (displayMode === 'desktop') {
      return <DesktopPane />;
    }
    return <TerminalPane />;
  };

  return (
    <div className="workspace-root">
      <header className="workspace-header">
        <div className="header-left">
          <button className="header-btn" onClick={toggleSidebar} title="Toggle files">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <span className="header-title">{config.agent_name}</span>
        </div>
        <div className="header-right">
          <button
            className={`header-btn display-toggle ${displayMode === 'desktop' ? 'active' : ''}`}
            onClick={toggleDisplayMode}
            title={displayMode === 'terminal' ? 'Switch to desktop' : 'Switch to terminal'}
          >
            {displayMode === 'terminal' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M9 11h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <button className="header-btn" onClick={toggleAwareness} title="Toggle awareness">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 2v2M9 14v2M2 9h2M14 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M4.2 13.8l1.4-1.4M12.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="workspace-body" ref={containerRef}>
        {/* Left: File Explorer */}
        {!sidebarCollapsed && (
          <>
            <div className="sidebar-panel" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span className="sidebar-title">Files</span>
              </div>
              <FileTree selectedPath={selectedPath} onFileSelect={handleFileSelect} />
            </div>
            <div className="resize-handle" onMouseDown={handleSidebarDragStart} />
          </>
        )}

        {/* Center: Terminal / Desktop / File Viewer */}
        <div className="center-panel">
          <CenterPanel />
        </div>

        {/* Right: Awareness Stream */}
        {!awarenessCollapsed && (
          <>
            <div className="resize-handle" onMouseDown={handleAwarenessDragStart} />
            <div className="awareness-sidebar" style={{ width: awarenessWidth }}>
              <AwarenessPane />
            </div>
          </>
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
  );
}
