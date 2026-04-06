import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiUrl, saveFile } from '../api';
import { Markdown } from './Markdown';

interface FileViewerProps {
  path: string;
  onClose: () => void;
}

async function fetchFile(path: string): Promise<string> {
  const response = await fetch(apiUrl(`/api/file?path=${encodeURIComponent(path)}`));
  if (!response.ok) throw new Error(`Failed to load file: ${response.status}`);
  return response.text();
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(path);
}

export function FileViewer({ path, onClose }: FileViewerProps) {
  const queryClient = useQueryClient();
  const { data: content, isLoading, error } = useQuery({
    queryKey: ['file', path],
    queryFn: () => fetchFile(path),
    staleTime: 10000,
  });

  const [edited, setEdited] = useState<string | null>(null);
  const [mode, setMode] = useState<'raw' | 'rendered'>(() => isMarkdown(path) ? 'rendered' : 'raw');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset edited state when path changes
  useEffect(() => {
    setEdited(null);
    setSaveError(null);
    setMode(isMarkdown(path) ? 'rendered' : 'raw');
  }, [path]);

  const currentContent = edited ?? content ?? '';
  const dirty = edited !== null && edited !== content;

  const handleSave = useCallback(async () => {
    if (!dirty || edited === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveFile(path, edited);
      // Update the cached content so dirty flag clears
      queryClient.setQueryData(['file', path], edited);
      setEdited(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [dirty, edited, path, queryClient]);

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  const fileName = path.split('/').pop() || path;
  const md = isMarkdown(path);
  const img = isImage(path);

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <div className="file-viewer-header-left">
          <span className="file-viewer-path" title={path}>{fileName}</span>
          {dirty && <span className="file-viewer-dirty" title="Unsaved changes" />}
        </div>
        <div className="file-viewer-header-right">
          {md && !img && (
            <button
              className={`file-viewer-toggle ${mode === 'rendered' ? 'active' : ''}`}
              onClick={() => setMode(mode === 'raw' ? 'rendered' : 'raw')}
              title={mode === 'raw' ? 'Preview' : 'Edit'}
            >
              {mode === 'raw' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              )}
            </button>
          )}
          {dirty && (
            <button
              className="file-viewer-save"
              onClick={handleSave}
              disabled={saving}
              title="Save (Ctrl+S)"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button className="file-viewer-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
      </div>

      {saveError && (
        <div className="file-viewer-error" onClick={() => setSaveError(null)}>
          {saveError}
        </div>
      )}

      <div className="file-viewer-content">
        {isLoading && <div className="file-viewer-status">Loading...</div>}
        {error && <div className="file-viewer-status error">Failed to load file</div>}
        {content != null && !img && (
          <>
            {md && mode === 'rendered' ? (
              <div className="file-viewer-markdown">
                <Markdown content={currentContent} />
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                className="file-viewer-editor"
                value={currentContent}
                onChange={(e) => setEdited(e.target.value)}
                spellCheck={false}
              />
            )}
          </>
        )}
        {content != null && img && (
          <div className="file-viewer-image">
            <img src={apiUrl(`/api/file?path=${encodeURIComponent(path)}`)} alt={fileName} />
          </div>
        )}
      </div>
    </div>
  );
}
