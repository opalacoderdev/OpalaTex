import React, { useEffect } from 'react';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function AlertModal({ message, onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!message) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' || event.key === 'Enter') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [message, onClose]);

  if (!message) return null;

  return (
    <div className="vscode-modal-overlay" role="presentation" onMouseDown={onClose}>
      <div className="vscode-modal" role="alertdialog" aria-modal="true" aria-labelledby="opalatex-alert-title" aria-describedby="opalatex-alert-message" onMouseDown={(event) => event.stopPropagation()} style={{ maxWidth: '460px', width: '90%' }}>
        <div className="vscode-sidebar-header" style={{ padding: '12px 16px' }}>
          <span id="opalatex-alert-title" className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)' }}>{t('alertModal.title')}</span>
          <button type="button" className="vscode-bottom-panel-clear-btn" onClick={onClose} aria-label={t('alertModal.close')}><X size={14} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '20px 18px', color: 'var(--vscode-text-fg)' }}>
          <Info size={24} style={{ flex: '0 0 auto', color: 'var(--vscode-accent)' }} />
          <div id="opalatex-alert-message" style={{ fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--vscode-border)', background: 'var(--vscode-sidebar-bg)' }}>
          <button type="button" className="vscode-button" onClick={onClose} autoFocus>{t('alertModal.ok')}</button>
        </div>
      </div>
    </div>
  );
}
