import React, { useEffect } from 'react';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../utils/openExternal';
import { SUCCESSOR_NAME, SUCCESSOR_URL } from '../../utils/successor';

// Startup notice that this is the final OpalaTex version. "Later" closes it for
// this launch only; "Don't show again" is remembered by the caller. The same
// information stays available in Settings > About either way.
export default function SunsetNoticeModal({ onLater, onDismiss }) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onLater();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onLater]);

  return (
    <div className="vscode-modal-overlay" role="presentation" onMouseDown={onLater}>
      <div className="vscode-modal" role="alertdialog" aria-modal="true" aria-labelledby="opalatex-sunset-title" aria-describedby="opalatex-sunset-message" onMouseDown={(event) => event.stopPropagation()} style={{ maxWidth: '520px', width: '90%' }}>
        <div className="vscode-modal-header">
          <span id="opalatex-sunset-title" className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)' }}>
            {t('sunsetNotice.title', { name: SUCCESSOR_NAME })}
          </span>
          <button type="button" className="vscode-bottom-panel-clear-btn" onClick={onLater} aria-label={t('alertModal.close')}><X size={14} /></button>
        </div>
        <div className="vscode-modal-content flex items-start" style={{ gap: '12px' }}>
          <Info size={24} style={{ flex: '0 0 auto', color: 'var(--vscode-accent)' }} />
          <div id="opalatex-sunset-message" style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', lineHeight: 1.5 }}>
            <span>{t('sunsetNotice.body', { name: SUCCESSOR_NAME })}</span>
            <code style={{ fontSize: '12px', overflowWrap: 'anywhere' }}>{SUCCESSOR_URL}</code>
          </div>
        </div>
        <div className="vscode-modal-footer">
          <button type="button" className="vscode-button-secondary" onClick={onDismiss}>{t('sunsetNotice.dontShowAgain')}</button>
          <button type="button" className="vscode-button-secondary" onClick={onLater}>{t('sunsetNotice.later')}</button>
          <button type="button" className="vscode-button" onClick={() => openExternal(SUCCESSOR_URL)} autoFocus>
            {t('sunsetNotice.open', { name: SUCCESSOR_NAME })}
          </button>
        </div>
      </div>
    </div>
  );
}
