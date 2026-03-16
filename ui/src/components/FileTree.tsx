import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '../api';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

interface FileTreeProps {
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
}

async function fetchFiles(path: string): Promise<FileNode[]> {
  const response = await fetch(apiUrl(`/api/files?path=${encodeURIComponent(path)}`));
  if (!response.ok) throw new Error('Failed to fetch files');
  const data = await response.json();
  return data.files || [];
}

const FILE_ICONS: Record<string, string> = {
  '.md': '\u{1F4DD}',
  '.json': '\u{1F4CB}',
  '.jsonl': '\u{1F4CB}',
  '.txt': '\u{1F4C4}',
  '.log': '\u{1F4DC}',
  '.ts': '\u{1F4C4}',
  '.js': '\u{1F4C4}',
  '.sh': '\u{2699}',
  directory: '\u{1F4C1}',
  default: '\u{1F4C4}',
};

function getFileIcon(node: FileNode): string {
  if (node.type === 'directory') return FILE_ICONS.directory;
  const ext = '.' + (node.name.split('.').pop() || '');
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  expandedPaths,
  onToggle,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;

  const { data: children, isLoading } = useQuery({
    queryKey: ['files', node.path],
    queryFn: () => fetchFiles(node.path),
    enabled: node.type === 'directory' && isExpanded,
    staleTime: 30000,
  });

  const handleClick = () => {
    if (node.type === 'directory') {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <>
      <div
        className={`tree-node ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={handleClick}
      >
        {node.type === 'directory' && (
          <span className="expand-icon">
            {isLoading ? '\u25CC' : isExpanded ? '\u25BE' : '\u25B8'}
          </span>
        )}
        {node.type === 'file' && <span className="expand-icon" />}
        <span className="file-icon">{getFileIcon(node)}</span>
        <span className="file-name">{node.name}</span>
        {node.size != null && <span className="file-size">{formatSize(node.size)}</span>}
      </div>

      {node.type === 'directory' && isExpanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
          {children.length === 0 && (
            <div className="empty-dir" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              (empty)
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function FileTree({ selectedPath, onFileSelect }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const { data: rootFiles, isLoading, error } = useQuery({
    queryKey: ['files', ''],
    queryFn: () => fetchFiles(''),
    staleTime: 30000,
  });

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (isLoading) return <div className="file-tree-status">Loading...</div>;
  if (error) return <div className="file-tree-status error">Failed to load files</div>;

  const files = rootFiles || [];

  return (
    <div className="file-tree">
      {files.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onToggle={handleToggle}
          onSelect={onFileSelect}
        />
      ))}
      {files.length === 0 && <div className="file-tree-status">No files yet</div>}
    </div>
  );
}
