import { useState, useRef, useCallback } from 'react';
import { uploadFiles } from '../api';

interface UploadZoneProps {
  targetDir?: string;
  onUploaded?: (paths: string[]) => void;
}

export function UploadZone({ targetDir = 'attachments', onUploaded }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragCountRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const paths = await uploadFiles(files, targetDir);
      onUploaded?.(paths);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [targetDir, onUploaded]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current === 0) setIsDragging(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, [handleFiles]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    handleFiles(files);
    // Reset input so same file can be re-uploaded
    e.target.value = '';
  }, [handleFiles]);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return {
    isDragging,
    uploading,
    error,
    dragProps: { onDragEnter, onDragLeave, onDragOver, onDrop },
    openFilePicker,
    FileInput: (
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={onFileInput}
        style={{ display: 'none' }}
      />
    ),
  };
}
