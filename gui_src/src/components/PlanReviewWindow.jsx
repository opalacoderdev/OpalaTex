import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

import FloatingAgentWindow from './FloatingAgentWindow';

const RECT_STORAGE_KEY = 'planReviewWindowRect';
const COLLAPSED_STORAGE_KEY = 'planReviewWindowCollapsed';

// A plan is full of paths, identifiers and URLs, and this window is narrow by
// design so the IDE stays visible beside it. Long words have to wrap rather
// than widen the window or push half a sentence behind a horizontal scrollbar
// while the user is being asked to approve it.
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
 * The proposed plan, as a floating window over a live IDE.
 *
 * Approving a plan is the one confirmation that genuinely needs the workbench:
 * the answer depends on the files, the outline and the compile log the plan
 * talks about. As a `ConfirmModal` it was drawn over `.vscode-modal-overlay`, a
 * full-screen backdrop that made all of that unreachable — so the user had to
 * approve or reject on the strength of the text alone, and the agent's wait
 * became the whole application's wait. Nothing about `create_plan` requires
 * that: only the agent is blocked, and it stays blocked either way.
 *
 * So this window has no backdrop, and therefore never captures a click meant
 * for the editor, the explorer, the terminal or the chat. It can be dragged,
 * resized and collapsed to its title bar; what it cannot be is dismissed. The
 * backend is holding a future open for up to 24h (`tools.create_plan`), and a
 * window the user could close would strand that future with no way to answer
 * it. `utils/floatingWindow.js` guarantees the rest: it can never be moved or
 * sized off screen, at any UI scale, whatever is in storage.
 */
export default function PlanReviewWindow({ planRequest, onConfirm }) {
  const { t } = useTranslation();

  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(planRequest?.markdown_content || '');
  // The parent clears the request only once the backend has taken the answer,
  // so the window survives a failed POST with the user's edits intact. What it
  // must not do meanwhile is let a second click send the decision twice.
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!planRequest) return null;

  const handleConfirm = async (action) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(action === 'yes'
        ? JSON.stringify({ response: action, editedContent: editedText })
        : action);
    } finally {
      setIsSubmitting(false);
    }
  };

  const options = planRequest.options || ['no', 'yes'];

  return (
    <FloatingAgentWindow
      className="plan-review-window"
      rectStorageKey={RECT_STORAGE_KEY}
      collapsedStorageKey={COLLAPSED_STORAGE_KEY}
      icon={<ClipboardList size={14} />}
      title={t('planReview.title', 'Plan Review')}
      waitingLabel={t('planReview.waiting', 'Waiting for your decision')}
      dragHint={t('planReview.dragHint', 'Drag to move this window')}
      resizeHint={t('planReview.resizeHint', 'Drag to resize this window')}
      collapseLabel={t('planReview.collapse', 'Collapse to title bar')}
      expandLabel={t('planReview.expand', 'Expand')}
      renderHeaderActions={() => (
        <button
          type="button"
          className="plan-window-header-btn"
          onClick={() => setIsEditing((prev) => !prev)}
          aria-pressed={isEditing}
          title={isEditing ? t('planReview.preview', 'Preview') : t('planReview.editPlan', 'Edit Plan')}
        >
          {isEditing ? t('planReview.preview', 'Preview') : t('planReview.editPlan', 'Edit Plan')}
        </button>
      )}
    >
      <>
        <p className="plan-window-prompt">{planRequest.prompt}</p>

        <div className={`plan-window-body${isEditing ? ' is-editing' : ''}`}>
          {isEditing ? (
            <textarea
              className="plan-window-editor"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              wrap="soft"
              aria-label={t('planReview.editPlan', 'Edit Plan')}
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

        <div className="plan-window-footer">
          {options.includes('no') && (
            <button
              type="button"
              id="confirm-no-btn"
              className="vscode-button plan-window-reject"
              onClick={() => handleConfirm('no')}
              disabled={isSubmitting}
            >
              {t('planReview.reject', 'Reject')}
            </button>
          )}
          {options.includes('yes') && (
            <button
              type="button"
              id="confirm-yes-btn"
              className="vscode-button"
              onClick={() => handleConfirm('yes')}
              disabled={isSubmitting}
            >
              {t('planReview.approve', 'Approve Plan')}
            </button>
          )}
        </div>
      </>
    </FloatingAgentWindow>
  );
}
