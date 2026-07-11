import React from 'react';
import { X } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';

// Startup prompt asking the user to install optional sentence-transformers dependencies.
export default function InstallDepsPrompt({ onClose, onInstall }) {
  const { t } = useTranslation();

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{ maxWidth: '440px', width: '90%' }}>
        <div className="vscode-sidebar-header" style={{ padding: '10px 16px' }}>
          <span className="vscode-sidebar-title" style={{ color: '#ffffff' }}>{t('installDepsPrompt.title')}</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1" style={{ padding: '16px', color: '#cccccc', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ fontSize: '13px', lineHeight: '1.5' }}>
            <Trans i18nKey="installDepsPrompt.body1" components={[<span />, <code />]} />
          </p>
          <p style={{ fontSize: '12px', color: '#888888', lineHeight: '1.4' }}>
            {t('installDepsPrompt.body2')}
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', borderTop: '1px solid #3c3c3c', paddingTop: '12px' }}>
            <button onClick={onClose} className="vscode-button" style={{ backgroundColor: '#3c3c3c', color: '#ffffff' }}>
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
