import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Modal displayed when the backend emits an input_request (type: ask).
export default function AskModal({ askRequest, onConfirm }) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (askRequest) {
      setInputValue('');
      setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 50);
    }
  }, [askRequest]);

  if (!askRequest) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(inputValue);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
      animation: 'fadeIn 0.15s ease',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1e1e2e 0%, #252537 100%)',
        border: '1px solid #3c3c5c',
        borderRadius: '12px',
        padding: '28px 32px',
        maxWidth: '480px',
        width: '90%',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <span style={{ fontSize: '22px' }}>🔔</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#a0a0c0', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('askModal.title', 'Input Required')}
          </span>
        </div>

        {/* Prompt text */}
        <p style={{ fontSize: '14px', color: '#e0e0f0', lineHeight: 1.6, marginBottom: '20px', margin: '0 0 20px 0' }}>
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
            placeholder="Digite sua resposta aqui..."
            style={{
              width: '100%', minHeight: '80px', padding: '12px', borderRadius: '8px',
              border: '1px solid #4c4c6c', background: '#181824', color: '#e0e0f0',
              fontSize: '14px', outline: 'none', resize: 'vertical'
            }}
          />

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => onConfirm('')}
              style={{
                padding: '8px 20px', borderRadius: '8px', border: '1px solid #4c4c6c',
                background: 'transparent', color: '#a0a0c0', cursor: 'pointer',
                fontSize: '13px', fontWeight: 600, transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.target.style.background = '#2c2c3c'; e.target.style.color = '#e0e0f0'; }}
              onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = '#a0a0c0'; }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              style={{
                padding: '8px 24px', borderRadius: '8px', border: 'none',
                background: 'linear-gradient(135deg, #007acc, #0062a3)',
                color: '#fff', cursor: 'pointer',
                fontSize: '13px', fontWeight: 700,
                boxShadow: '0 4px 16px rgba(0,122,204,0.35)',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.target.style.background = 'linear-gradient(135deg, #0090f0, #007acc)'; }}
              onMouseLeave={e => { e.target.style.background = 'linear-gradient(135deg, #007acc, #0062a3)'; }}
            >
              Enviar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
