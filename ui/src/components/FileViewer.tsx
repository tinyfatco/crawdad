import { useQuery } from '@tanstack/react-query';

interface FileViewerProps {
  path: string;
  onClose: () => void;
}

import { apiUrl } from '../api';

async function fetchFile(path: string): Promise<string> {
  const response = await fetch(apiUrl(`/api/file?path=${encodeURIComponent(path)}`));
  if (!response.ok) throw new Error(`Failed to load file: ${response.status}`);
  return response.text();
}

export function FileViewer({ path, onClose }: FileViewerProps) {
  const { data: content, isLoading, error } = useQuery({
    queryKey: ['file', path],
    queryFn: () => fetchFile(path),
    staleTime: 10000,
  });

  const fileName = path.split('/').pop() || path;

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <span className="file-viewer-path" title={path}>{fileName}</span>
        <button className="file-viewer-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      <div className="file-viewer-content">
        {isLoading && <div className="file-viewer-status">Loading...</div>}
        {error && <div className="file-viewer-status error">Failed to load file</div>}
        {content != null && (
          <pre className="file-viewer-pre">{content}</pre>
        )}
      </div>
    </div>
  );
}
