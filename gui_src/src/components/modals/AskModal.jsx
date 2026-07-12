import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Modal displayed when the backend emits an input_request (type: ask).
export default function AskModal({ askRequest, onConfirm }) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (askRequest) {
      setInputValue(askRequest.default || '');
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          if (askRequest.default) {
            inputRef.current.select();
          }
        }
      }, 50);
    }
  }, [askRequest]);

  if (!askRequest) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(inputValue);
  };

  return (
    <div className="vscode-modal-overlay" style={{ zIndex: 1000, backdropFilter: 'blur(4px)' }}>
      <div className="vscode-modal" style={{
        padding: '28px 32px',
        maxWidth: '480px',
        width: '90%',
        borderRadius: '12px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <span style={{ fontSize: '22px' }}>🔔</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--vscode-descriptionForeground, #a0a0c0)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('askModal.title', 'Input Required')}
          </span>
        </div>

        {/* Prompt text */}
        <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg, #e0e0f0)', lineHeight: 1.6, marginBottom: '20px', margin: '0 0 20px 0' }}>
          {askRequest.prompt}
        </p>

        {/* Input form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={t('askModal.placeholder', 'Type your answer here...')}
            rows={askRequest.rows || 3}
            style={{
              width: '100%',
              minHeight: askRequest.rows === 1 ? '40px' : '80px',
              padding: '12px',
              borderRadius: '8px',
              fontSize: '14px',
              outline: 'none',
              resize: askRequest.rows === 1 ? 'none' : 'vertical'
            }}
          />

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => onConfirm('')}
              className="vscode-button"
              style={{
                background: 'transparent', border: '1px solid var(--vscode-border, #4c4c6c)',
                color: 'var(--vscode-text-fg, #a0a0c0)', cursor: 'pointer',
                fontSize: '13px', fontWeight: 600, padding: '8px 20px', borderRadius: '8px',
                transition: 'all 0.15s',
              }}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              className="vscode-button"
              style={{
                padding: '8px 24px', borderRadius: '8px', border: 'none',
                background: 'var(--vscode-button-background, #007acc)',
                color: '#fff', cursor: 'pointer',
                fontSize: '13px', fontWeight: 700,
                boxShadow: '0 4px 16px rgba(0,122,204,0.25)',
                transition: 'all 0.15s',
              }}
            >
              {t('askModal.send', 'Send')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
