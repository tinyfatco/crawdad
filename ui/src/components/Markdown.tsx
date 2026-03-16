import { useMemo } from 'react';
import { marked } from 'marked';

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  const html = useMemo(() => {
    return marked.parse(content, { breaks: true, async: false }) as string;
  }, [content]);

  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
