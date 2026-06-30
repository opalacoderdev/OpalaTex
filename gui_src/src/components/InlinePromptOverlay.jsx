import React, { useEffect, useRef, useState } from 'react';
import { Send, X, Wand2, MessageSquarePlus, Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * InlinePromptOverlay
 *
 * A floating panel that appears anchored near the Monaco cursor/selection.
 * Props:
 *   inlinePrompt  — { x, y, startLine, endLine, cursorCol, selectedText, mode }
 *                   mode: 'free' | 'refine' | 'fix' | 'createIllustration'
 *   onSubmit(instruction: string) — called when user confirms
 *   onClose()                     — called when user dismisses
 *   isRunning                     — true if the backend task is currently processing
 */
export default function InlinePromptOverlay({ inlinePrompt, onSubmit, onClose, onCancel, isRunning }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!isRunning) { setDotCount(1); return; }
    const id = setInterval(() => setDotCount(d => (d % 3) + 1), 500);
    return () => clearInterval(id);
  }, [isRunning]);

  const animatedDots = '.'.repeat(dotCount);

  // Reset value and focus when prompt opens / mode changes
  useEffect(() => {
    if (!inlinePrompt) return;
    const defaults = {
      refine: t('editorPanel.inlinePromptRefineDefault'),
      generate: t('editorPanel.inlinePromptGenerateDefault', 'Generate code here...'),
      createIllustration: t('editorPanel.inlinePromptCreateIllustrationDefault', 'Create an SVG illustration for this text'),
      free: '',
    };
    setValue(defaults[inlinePrompt.mode] ?? '');
    // Slight delay so Monaco doesn't steal focus back
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [inlinePrompt]);

  if (!inlinePrompt) return null;

  const { startLine, endLine, selectedText, mode } = inlinePrompt;

  const modeIcon = {
    refine: <Wand2 size={13} style={{ color: '#4ec9b0' }} />,
    generate: <MessageSquarePlus size={13} style={{ color: '#f48771' }} />,
    createIllustration: <Palette size={13} style={{ color: '#c586c0' }} />,
    free: <MessageSquarePlus size={13} style={{ color: '#75beff' }} />,
  }[mode] ?? null;

  const modeLabel = {
    refine: t('editorPanel.refineSelection'),
    generate: t('editorPanel.generateCode', 'Generate Code'),
    createIllustration: t('editorPanel.createIllustration', 'Create Illustration'),
    free: t('editorPanel.inlinePromptTitle'),
  }[mode] ?? '';

  const hasSelection = selectedText && selectedText.trim().length > 0;
  const lineInfo = hasSelection
    ? `Lines ${startLine}–${endLine}`
    : `Line ${startLine}, col ${inlinePrompt.cursorCol}`;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const handleSubmit = () => {
    const instruction = value.trim();
    if (!instruction) return;
    onSubmit(instruction);
  };

  const overlayWidth = 420;
  const safeX = Math.round((window.innerWidth - overlayWidth) / 2);
  const safeY = Math.round(window.innerHeight * 0.35);



  return (
    <>
      <style>{`
        @keyframes opc-pulse-border {
          0%, 100% { border-left-color: #007acc; opacity: 1; }
          50% { border-left-color: #4ec9b0; opacity: 0.7; }
        }
        .opc-thinking-block {
          animation: opc-pulse-border 1.2s ease-in-out infinite;
        }
        @keyframes opc-spin {
          to { transform: rotate(360deg); }
        }
        .opc-spinner {
          display: inline-block;
          width: 10px;
          height: 10px;
          border: 1.5px solid #555;
          border-top-color: #007acc;
          border-radius: 50%;
          animation: opc-spin 0.7s linear infinite;
          vertical-align: middle;
          margin-right: 5px;
        }
      `}</style>
      {/* Backdrop — clicking outside closes overlay */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'transparent',
        }}
        onMouseDown={isRunning ? undefined : onClose}
      />

      {/* Overlay panel */}
      <div
        style={{
          position: 'fixed',
          top: `${safeY}px`,
          left: `${safeX}px`,
          zIndex: 9999,
          width: `${overlayWidth}px`,
          background: 'rgba(30, 30, 35, 0.92)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'inlineOverlayFadeIn 0.12s ease-out',
        }}
        onMouseDown={(e) => e.stopPropagation()} // prevent backdrop close
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {modeIcon}
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#ccc', letterSpacing: '0.03em' }}>
              {modeLabel}
            </span>
            <span style={{ fontSize: '10px', color: '#555', marginLeft: '4px' }}>
              {lineInfo}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={isRunning}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              color: isRunning ? '#444' : '#666',
              padding: '2px',
              display: 'flex',
              alignItems: 'center',
              borderRadius: '3px',
            }}
            onMouseEnter={(e) => { if (!isRunning) e.currentTarget.style.color = '#aaa'; }}
            onMouseLeave={(e) => { if (!isRunning) e.currentTarget.style.color = '#666'; }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Snippet preview (if selection) */}
        {hasSelection && (
          <div
            style={{
              fontSize: '10px',
              color: '#888',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: '4px',
              padding: '4px 6px',
              maxHeight: '40px',
              overflow: 'hidden',
              whiteSpace: 'pre',
              fontFamily: 'monospace',
              borderLeft: '2px solid #3c3c5c',
            }}
          >
            {selectedText.length > 120 ? selectedText.slice(0, 120) + '…' : selectedText}
          </div>
        )}

        {/* Input row */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('editorPanel.inlinePromptPlaceholder')}
            disabled={isRunning}
            style={{
              flex: 1,
              fontSize: '12px',
              padding: '5px 8px',
              background: isRunning ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '5px',
              color: isRunning ? '#888' : '#e0e0e0',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => { if (!isRunning) { e.currentTarget.style.borderColor = '#007acc'; e.currentTarget.select(); } }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; }}
          />
          <button
            onClick={handleSubmit}
            disabled={!value.trim() || isRunning}
            style={{
              background: value.trim() && !isRunning ? '#007acc' : '#2a2a2a',
              border: 'none',
              borderRadius: '5px',
              color: value.trim() && !isRunning ? '#fff' : '#555',
              cursor: value.trim() && !isRunning ? 'pointer' : 'not-allowed',
              padding: '5px 9px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { if (value.trim() && !isRunning) e.currentTarget.style.background = '#1177bb'; }}
            onMouseLeave={(e) => { if (value.trim() && !isRunning) e.currentTarget.style.background = '#007acc'; }}
          >
            {isRunning ? (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="2" x2="12" y2="6"></line>
                <line x1="12" y1="18" x2="12" y2="22"></line>
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                <line x1="2" y1="12" x2="6" y2="12"></line>
                <line x1="18" y1="12" x2="22" y2="12"></line>
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                <line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line>
              </svg>
            ) : (
              <Send size={12} />
            )}
            <span>{isRunning ? '...' : t('editorPanel.inlinePromptSend')}</span>
          </button>
          
          {isRunning && (
            <button
              onClick={onCancel}
              style={{
                background: '#442222',
                border: '1px solid #ff4444',
                borderRadius: '5px',
                color: '#ff8888',
                cursor: 'pointer',
                padding: '5px 9px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#662222'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#442222'}
            >
              <X size={12} />
              <span>{t('editorPanel.inlinePromptCancel', 'Cancel')}</span>
            </button>
          )}
        </div>

        {/* Hint */}
        <span style={{ fontSize: '10px', color: isRunning ? '#888' : '#444', userSelect: 'none', display: 'flex', alignItems: 'center' }}>
          {isRunning
            ? <><span className="opc-spinner" />{`OpalaTex is working${animatedDots}`}</>
            : `Enter ${t('editorPanel.inlinePromptSend').toLowerCase()} · Esc ${t('editorPanel.inlinePromptCancel').toLowerCase()}`
          }
        </span>


      </div>
    </>
  );
}
