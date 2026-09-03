import React from 'react';
import { X } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';

// Startup prompt asking the user to install optional sentence-transformers dependencies.
export default function InstallDepsPrompt({ onClose, onInstall }) {
  const { t } = useTranslation();

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{ maxWidth: '440px', width: '90%' }}>
        <div className="vscode-modal-header">
          <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)' }}>{t('installDepsPrompt.title')}</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-subtle)' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="vscode-modal-content overflow-y-auto flex-1 flex flex-col" style={{ gap: '12px' }}>
          <p style={{ fontSize: '13px', lineHeight: '1.5' }}>
            <Trans i18nKey="installDepsPrompt.body1" components={[<span />, <code />]} />
          </p>
          <p style={{ fontSize: '12px', color: 'var(--vscode-text-muted)', lineHeight: '1.4' }}>
            {t('installDepsPrompt.body2')}
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px' }}>
            <button onClick={onClose} className="vscode-button-secondary">
              {t('installDepsPrompt.ignore')}
            </button>
            <button onClick={onInstall} className="vscode-button">
              {t('installDepsPrompt.installNow')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
