import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// Modal displayed when the backend emits an input_request (Yes/No confirmation).
export default function ConfirmModal({ confirmRequest, onConfirm }) {
  const { t } = useTranslation();
  
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(confirmRequest?.markdown_content || "");

  if (!confirmRequest) return null;

  const hasMarkdown = !!confirmRequest.markdown_content;

  const handleConfirm = (action) => {
    if (hasMarkdown && action === 'yes') {
      onConfirm(JSON.stringify({ response: action, editedContent: editedText }));
    } else {
      onConfirm(action);
    }
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{
        maxWidth: hasMarkdown ? '800px' : '420px',
        width: '90%',
        maxHeight: '90vh',
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
          {hasMarkdown && (
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="vscode-button"
              style={{
                background: isEditing ? 'var(--vscode-button-bg)' : 'transparent',
                color: isEditing ? 'var(--vscode-button-fg)' : 'var(--vscode-text-fg)',
                border: '1px solid var(--vscode-button-bg)',
                padding: '4px 12px',
                fontSize: '12px',
                transition: 'all 0.2s'
              }}
            >
              {isEditing ? t('confirmModal.preview', 'Preview') : t('confirmModal.editPlan', 'Edit Plan')}
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          {/* Prompt text */}
          <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg)', lineHeight: 1.6, marginBottom: '16px', marginTop: '16px' }}>
            {confirmRequest.prompt}
          </p>

          {/* Markdown Content (if available) */}
          {hasMarkdown && (
            <div className="markdown-body" style={{ 
              flex: 1, 
              overflowY: 'auto', 
              background: 'var(--vscode-editor-bg)', 
              padding: isEditing ? '0' : '16px', 
              borderRadius: '4px', 
              border: '1px solid var(--vscode-border)',
              marginBottom: '20px',
              fontSize: '14px',
              color: 'var(--vscode-text-fg)',
              display: 'flex',
              flexDirection: 'column'
            }}>
              {isEditing ? (
                <textarea
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                  style={{
                    flex: 1,
                    width: '100%',
                    minHeight: '300px',
                    background: 'transparent',
                    color: 'var(--vscode-text-fg)',
                    border: 'none',
                    padding: '16px',
                    fontSize: '14px',
                    fontFamily: 'var(--vscode-editor-font)',
                    resize: 'none',
                    outline: 'none'
                  }}
                />
              ) : (
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { strict: "ignore" }]]}>
                  {editedText}
                </ReactMarkdown>
              )}
            </div>
          )}
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
                  onClick={() => handleConfirm('cancel')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {t('confirmModal.cancel', 'Cancel')}
                </button>
              );
            }
            if (opt === 'no') {
              return (
                <button
                  key="no"
                  id="confirm-no-btn"
                  onClick={() => handleConfirm('no')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {t('confirmModal.no')}
                </button>
              );
            }
            if (opt === 'yes') {
              return (
                <button
                  key="yes"
                  id="confirm-yes-btn"
                  onClick={() => handleConfirm('yes')}
                  className="vscode-button"
                >
                  {t('confirmModal.yes')}
                </button>
              );
            }
            if (opt === 'always') {
              return (
                <button
                  key="always"
                  id="confirm-always-btn"
                  onClick={() => handleConfirm('always')}
                  className="vscode-button"
                  style={{ background: '#2ea043', border: '1px solid #238636', color: '#ffffff' }}
                >
                  {t('confirmModal.always', 'Always Allow')}
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
