import React from 'react';
import { useTranslation } from 'react-i18next';

// Modal displayed when the backend emits an input_request (Yes/No confirmation).
//
// Short decisions only. A request that carries `markdown_content` is a proposed
// plan and is routed to `components/PlanPanel.jsx` instead: reviewing a plan
// means reading the files it talks about, and this dialog's backdrop covers the
// workbench. What is left here is the class of question a backdrop is right for
// — a tool asking to run, answered in a second without leaving the dialog.
export default function ConfirmModal({ confirmRequest, onConfirm }) {
  const { t } = useTranslation();

  if (!confirmRequest) return null;

  const buttonLabel = (key, defaultValue) => {
    const label = t(key, { defaultValue });
    return label === key ? defaultValue : label;
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{
        maxWidth: '420px',
        width: '90%',
        maxHeight: 'calc(90 * var(--ui-vh))',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div className="vscode-sidebar-header" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>🔔</span>
            <span className="vscode-sidebar-title" style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {t('confirmModal.title', 'Confirm')}
            </span>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg)', lineHeight: 1.6, marginBottom: '16px', marginTop: '16px' }}>
            {confirmRequest.prompt}
          </p>
        </div>

        {/* Footer Buttons */}
        <div style={{ 
          display: 'flex', gap: '8px', justifyContent: 'flex-end', 
          padding: '16px 20px', borderTop: '1px solid var(--vscode-border)', 
          backgroundColor: 'var(--vscode-sidebar-bg)' 
        }}>
          {(confirmRequest.options || ['no', 'yes']).map(opt => {
            if (opt === 'cancel') {
              return (
                <button
                  key="cancel"
                  onClick={() => onConfirm('cancel')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {buttonLabel('confirmModal.cancel', 'Cancel')}
                </button>
              );
            }
            if (opt === 'no') {
              return (
                <button
                  key="no"
                  id="confirm-no-btn"
                  onClick={() => onConfirm('no')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {buttonLabel('confirmModal.no', 'No')}
                </button>
              );
            }
            if (opt === 'yes') {
              return (
                <button
                  key="yes"
                  id="confirm-yes-btn"
                  onClick={() => onConfirm('yes')}
                  className="vscode-button"
                >
                  {buttonLabel('confirmModal.yes', 'Yes')}
                </button>
              );
            }
            if (opt === 'always') {
              return (
                <button
                  key="always"
                  id="confirm-always-btn"
                  onClick={() => onConfirm('always')}
                  className="vscode-button"
                  style={{ background: '#2ea043', border: '1px solid #238636', color: '#ffffff' }}
                >
                  {buttonLabel('confirmModal.always', 'Always Allow')}
                </button>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}
