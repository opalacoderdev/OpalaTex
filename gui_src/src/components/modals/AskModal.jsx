import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Matches a model-provided "other"/"none of the above" style choice (en/pt/es)
// so it can be filtered out before we append our own free-text "Other" option below.
const OTHER_OPTION_PATTERN = /^(outr[oa]s?|other|otro)\b/i;

// Modal displayed when the backend emits an input_request (type: ask).
export default function AskModal({ askRequest, onConfirm }) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [selectedOption, setSelectedOption] = useState(null); // index, 'other', or null
  const inputRef = useRef(null);

  const rawOptions = Array.isArray(askRequest?.options) && askRequest.options.length > 0
    ? askRequest.options
    : null;

  // The UI always appends its own "Other" write-in choice below, so drop any
  // equivalent catch-all the model may have added on its own to avoid showing
  // two "other" entries.
  const options = rawOptions
    ? rawOptions.filter((opt) => !OTHER_OPTION_PATTERN.test(String(opt).trim()))
    : null;

  useEffect(() => {
    if (askRequest) {
      setInputValue(askRequest.default || '');
      if (options && options.length > 0) {
        setSelectedOption(0); // Select first option by default
      } else {
        setSelectedOption('other');
      }
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
    if (e) e.preventDefault();
    if (options && selectedOption !== 'other' && selectedOption !== null) {
      const chosen = options[selectedOption];
      onConfirm(chosen);
    } else {
      onConfirm(inputValue);
    }
  };

  const handleOptionClick = (idx) => {
    setSelectedOption(idx);
  };

  const handleOptionDoubleClick = (idx) => {
    setSelectedOption(idx);
    const chosen = options[idx];
    onConfirm(chosen);
  };

  const handleSelectOther = () => {
    setSelectedOption('other');
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 50);
  };

  return (
    <div className="vscode-modal-overlay" style={{ zIndex: 1000, backdropFilter: 'blur(4px)' }}>
      <div className="vscode-modal" style={{
        padding: '28px 32px',
        maxWidth: '540px',
        width: '90%',
        borderRadius: '12px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <span style={{ fontSize: '22px' }}>🔔</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--vscode-descriptionForeground)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('askModal.title', 'Input Required')}
          </span>
        </div>

        {/* Prompt text */}
        <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg)', lineHeight: 1.6, marginBottom: options ? '16px' : '20px', margin: 0 }}>
          {askRequest.prompt}
        </p>

        {/* Options list if provided */}
        {options && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)' }}>
              {t('askModal.optionsTitle', 'Select an option:')}
            </div>
            {options.map((opt, idx) => {
              const isSelected = selectedOption === idx;
              return (
                <div
                  key={idx}
                  onClick={() => handleOptionClick(idx)}
                  onDoubleClick={() => handleOptionDoubleClick(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    lineHeight: 1.4,
                    border: isSelected 
                      ? '1px solid var(--vscode-active-border, #007acc)' 
                      : '1px solid var(--vscode-border)',
                    background: isSelected 
                      ? 'var(--vscode-list-activeSelectionBg, #094771)' 
                      : 'var(--vscode-input-bg, #2d2d2d)',
                    color: isSelected ? 'var(--vscode-list-activeSelectionFg, #ffffff)' : 'var(--vscode-text-fg)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '20px',
                    height: '20px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    background: isSelected ? 'var(--vscode-button-bg, #0e639c)' : 'var(--vscode-descriptionForeground)',
                    color: '#fff',
                    flexShrink: 0,
                  }}>
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1 }}>{opt}</span>
                </div>
              );
            })}

            {/* Custom "Other" option */}
            <div
              onClick={handleSelectOther}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                border: selectedOption === 'other' 
                  ? '1px solid var(--vscode-active-border, #007acc)' 
                  : '1px solid var(--vscode-border)',
                background: selectedOption === 'other' 
                  ? 'var(--vscode-list-activeSelectionBg, #094771)' 
                  : 'var(--vscode-input-bg, #2d2d2d)',
                color: selectedOption === 'other' ? 'var(--vscode-list-activeSelectionFg, #ffffff)' : 'var(--vscode-text-fg)',
                transition: 'all 0.15s ease',
              }}
            >
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 700,
                background: selectedOption === 'other' ? 'var(--vscode-button-bg, #0e639c)' : 'var(--vscode-descriptionForeground)',
                color: '#fff',
                flexShrink: 0,
              }}>
                ✎
              </span>
              <span style={{ flex: 1, fontWeight: selectedOption === 'other' ? 600 : 400 }}>
                {t('askModal.otherOption', 'Other (write in below)')}
              </span>
            </div>
          </div>
        )}

        {/* Input form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: options ? '4px' : '16px' }}>
          {(!options || selectedOption === 'other') && (
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
              placeholder={options ? t('askModal.otherPlaceholder', 'Type your custom response...') : t('askModal.placeholder', 'Type your answer here...')}
              rows={options ? 2 : (askRequest.rows || 3)}
              style={{
                width: '100%',
                minHeight: options ? '60px' : (askRequest.rows === 1 ? '40px' : '80px'),
                padding: '12px',
                borderRadius: '8px',
                fontSize: '13px',
                outline: 'none',
                resize: 'vertical',
                background: 'var(--vscode-input-bg, #2d2d2d)',
                color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
                border: '1px solid var(--vscode-input-border, var(--vscode-border))',
              }}
            />
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              onClick={() => onConfirm('')}
              className="vscode-button"
              style={{
                background: 'transparent', border: '1px solid var(--vscode-border)',
                color: 'var(--vscode-text-fg)', cursor: 'pointer',
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
                background: 'var(--vscode-button-bg, #0e639c)',
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
