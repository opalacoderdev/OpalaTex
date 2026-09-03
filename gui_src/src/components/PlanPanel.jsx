import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

// Long words in a plan (paths, identifiers, URLs) have to wrap rather than
// widen the panel: this dock is narrow by design, and a horizontal scrollbar
// on the plan would put half of a sentence off-screen while the user is being
// asked to approve it.
const markdownComponents = {
  p: ({ children }) => (
    <p style={{ margin: '8px 0', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
      {children}
    </p>
  ),
  pre: ({ children }) => (
    <pre style={{
      margin: '8px 0',
      padding: '10px',
      background: 'var(--vscode-input-bg, #2d2d2d)',
      borderRadius: '4px',
      overflowX: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflowWrap: 'break-word',
      fontSize: '13px',
      fontFamily: 'var(--vscode-editor-font, monospace)'
    }}>
      {children}
    </pre>
  ),
  code: ({ inline, children }) => {
    if (inline) {
      return (
        <code style={{
          padding: '2px 4px',
          borderRadius: '3px',
          fontFamily: 'var(--vscode-editor-font, monospace)',
          fontSize: '12px',
          background: 'var(--vscode-input-bg, #2d2d2d)',
          color: 'var(--vscode-textPreformat-foreground, #d7ba7d)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'break-word'
        }}>
          {children}
        </code>
      );
    }
    return (
      <code style={{
        fontFamily: 'var(--vscode-editor-font, monospace)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'break-word'
      }}>
        {children}
      </code>
    );
  },
  li: ({ children }) => (
    <li style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
      {children}
    </li>
  )
};

/**
 * The proposed plan, docked where the chat sits in the IDE layout.
 *
 * This is the one place a plan is rendered. It used to be a `ConfirmModal` over
 * a full-screen backdrop, which held the decision and the workbench hostage
 * together: the agent genuinely cannot continue without an answer, but the user
 * could not open the files the plan talks about in order to give one. Only the
 * agent has to wait, so the plan became a panel and the editor, the explorer
 * and the terminal stay live behind it.
 *
 * The panel does not close on its own. `App.jsx` unmounts it when the pending
 * request is answered, and until then the activity bar keeps a way back to it,
 * so a decision cannot be lost by switching layouts.
 */
export default function PlanPanel({ planRequest, onRespond, chatWidth }) {
  const { t } = useTranslation();

  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(planRequest?.markdown_content || '');

  if (!planRequest) return null;

  // The wire contract is `create_plan`'s (opalatex/tools.py): an approval may
  // carry the edited plan as JSON, a rejection is the bare token. Rejecting
  // makes the tool raise, so the turn stops and the user's feedback goes to
  // the chat as an ordinary message — which is why rejection restores the
  // layout that has the chat in it.
  const approve = () => onRespond(JSON.stringify({ response: 'yes', editedContent: editedText }));
  const reject = () => onRespond('no');

  return (
    <aside className="vscode-chat" style={{ width: `${chatWidth}px` }}>
      <div
        className="vscode-chat-header"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <ClipboardList size={16} />
          <span style={{
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            fontSize: '11px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {t('planPanel.title', 'Proposed Plan')}
          </span>
        </div>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="vscode-button"
          style={{
            background: isEditing ? 'var(--vscode-button-bg)' : 'transparent',
            color: isEditing ? 'var(--vscode-button-fg)' : 'var(--vscode-text-fg)',
            border: '1px solid var(--vscode-button-bg)',
            padding: '2px 10px',
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          {isEditing ? t('planPanel.preview', 'Preview') : t('planPanel.edit', 'Edit')}
        </button>
      </div>

      <div style={{ padding: '12px 12px 0', flexShrink: 0 }}>
        <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--vscode-text-muted, var(--vscode-text-fg))' }}>
          {planRequest.prompt}
        </p>
      </div>

      <div
        className="markdown-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          margin: '12px',
          background: 'var(--vscode-editor-bg)',
          border: '1px solid var(--vscode-border)',
          borderRadius: '4px',
          padding: isEditing ? '0' : '12px',
          fontSize: '13px',
          color: 'var(--vscode-text-fg)',
          display: 'flex',
          flexDirection: 'column',
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
        }}
      >
        {isEditing ? (
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            wrap="soft"
            style={{
              flex: 1,
              width: '100%',
              background: 'transparent',
              color: 'var(--vscode-text-fg)',
              border: 'none',
              padding: '12px',
              fontSize: '13px',
              fontFamily: 'var(--vscode-editor-font)',
              resize: 'none',
              outline: 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
            }}
          />
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[[rehypeKatex, { strict: 'ignore', output: 'mathml' }]]}
            components={markdownComponents}
          >
            {editedText}
          </ReactMarkdown>
        )}
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        borderTop: '1px solid var(--vscode-border)',
        backgroundColor: 'var(--vscode-sidebar-bg)',
        flexShrink: 0,
      }}>
        <p style={{ margin: 0, fontSize: '11px', lineHeight: 1.4, color: 'var(--vscode-text-muted, var(--vscode-text-fg))' }}>
          {t('planPanel.rejectHint', 'Rejecting stops the turn and returns to the chat, where you can say what to change.')}
        </p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            id="plan-reject-btn"
            onClick={reject}
            className="vscode-button"
            style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
          >
            {t('planPanel.reject', 'Reject')}
          </button>
          <button
            id="plan-approve-btn"
            onClick={approve}
            className="vscode-button"
          >
            {t('planPanel.approve', 'Approve')}
          </button>
        </div>
      </div>
    </aside>
  );
}
