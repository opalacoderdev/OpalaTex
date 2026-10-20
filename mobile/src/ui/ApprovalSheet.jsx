import React from 'react';
import { useTranslation } from 'react-i18next';

/** The exact change the agent wants to write, shown before anything is written. */
export default function ApprovalSheet({ change, onAnswer }) {
  const { t } = useTranslation();
  const title = change.kind === 'create'
    ? t('approval.createTitle', { path: change.path })
    : t('approval.editTitle', { path: change.path });
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet">
        <h2>{title}</h2>
        <p className="muted small">{t('approval.body')}</p>
        {change.kind === 'edit' && (
          <>
            <h3>{t('approval.before')}</h3>
            <pre className="diff removed">{change.before}</pre>
          </>
        )}
        <h3>{t('approval.after')}</h3>
        <pre className="diff added">{change.after}</pre>
        <div className="sheet-actions">
          <button type="button" onClick={() => onAnswer(false)}>{t('approval.decline')}</button>
          <button type="button" className="primary" onClick={() => onAnswer(true)}>{t('approval.approve')}</button>
        </div>
      </div>
    </div>
  );
}
