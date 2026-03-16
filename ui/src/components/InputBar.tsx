import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
}

export function InputBar({ onSend, onStop, disabled, isStreaming }: InputBarProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      onSend(value);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSubmit();
    }
  };

  return (
    <div className="input-bar">
      <div className="input-container">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Agent is working...' : 'Type a message...'}
          disabled={disabled && !isStreaming}
          rows={1}
        />

        {isStreaming ? (
          <button className="control-button stop" onClick={onStop} aria-label="Stop">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className="send-button"
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
