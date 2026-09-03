import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, ClipboardList } from 'lucide-react';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { safeGetLocalStorage, safeSetLocalStorage } from '../utils/storage';
import {
  clampPlanWindowRect,
  defaultPlanWindowRect,
  movePlanWindowRect,
  parsePlanWindowRect,
  resizePlanWindowRect,
} from '../utils/floatingWindow';

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

/** The viewport in the app's own CSS pixels — see utils/uiScale.js. */
const appViewport = () => {
  const scale = readUiScale();
  return {
    width: viewportPxToApp(window.innerWidth, scale),
    height: viewportPxToApp(window.innerHeight, scale),
  };
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
  const [collapsed, setCollapsed] = useState(
    () => safeGetLocalStorage(COLLAPSED_STORAGE_KEY, 'false') === 'true'
  );
  const [rect, setRect] = useState(() => {
    const viewport = appViewport();
    const stored = parsePlanWindowRect(safeGetLocalStorage(RECT_STORAGE_KEY, null));
    return stored ? clampPlanWindowRect(stored, viewport) : defaultPlanWindowRect(viewport);
  });

  // The parent clears the request only once the backend has taken the answer,
  // so the window survives a failed POST with the user's edits intact. What it
  // must not do meanwhile is let a second click send the decision twice.
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [gesture, setGesture] = useState(null); // 'move' | 'resize' | null
  const pointerRef = useRef(null);
  // Read by handlers that live in a window-level listener and must not
  // re-subscribe every time one of these changes mid-gesture.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const startGesture = (kind) => (e) => {
    // Only the primary button, and never from a control that has its own click.
    if (e.button !== 0 || e.target.closest('button')) return;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    setGesture(kind);
    e.preventDefault();
  };

  useEffect(() => {
    if (!gesture) return undefined;
    const scale = readUiScale();
    const handleMove = (e) => {
      const last = pointerRef.current;
      if (!last) return;
      // Pointer coordinates are real viewport pixels; the rectangle is a CSS
      // length inside the zoomed app. The delta has to cross that boundary.
      const dx = viewportPxToApp(e.clientX - last.x, scale);
      const dy = viewportPxToApp(e.clientY - last.y, scale);
      pointerRef.current = { x: e.clientX, y: e.clientY };
      setRect((prev) => (gesture === 'move'
        ? movePlanWindowRect(prev, dx, dy, appViewport(), { collapsed: collapsedRef.current })
        : resizePlanWindowRect(prev, dx, dy, appViewport())));
    };
    const endGesture = () => {
      pointerRef.current = null;
      setGesture(null);
      // Persist once the gesture settles rather than on every pointer move.
      safeSetLocalStorage(RECT_STORAGE_KEY, JSON.stringify(rectRef.current));
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endGesture);
    window.addEventListener('pointercancel', endGesture);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endGesture);
      window.removeEventListener('pointercancel', endGesture);
    };
  }, [gesture]);

  // Resizing the OS window, or changing the UI scale, can leave a stored
  // rectangle hanging outside the new viewport. Clamping is idempotent, so this
  // settles in one pass and never fights the user's own drag.
  useLayoutEffect(() => {
    const reclamp = () => {
      setRect((prev) => {
        const next = clampPlanWindowRect(prev, appViewport(), { collapsed: collapsedRef.current });
        return next.x === prev.x && next.y === prev.y && next.width === prev.width && next.height === prev.height
          ? prev
          : next;
      });
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      safeSetLocalStorage(COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  };

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
    <div
      className={`plan-window${gesture ? ' is-gesturing' : ''}${collapsed ? ' is-collapsed' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={t('planReview.title', 'Plan Review')}
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: collapsed ? 'auto' : `${rect.height}px`,
      }}
    >
      <div
        className="plan-window-header"
        onPointerDown={startGesture('move')}
        onDoubleClick={toggleCollapsed}
        title={t('planReview.dragHint', 'Drag to move this window')}
      >
        <ClipboardList size={14} />
        <span className="plan-window-title">{t('planReview.title', 'Plan Review')}</span>
        <span className="plan-window-waiting" aria-live="polite">
          <span className="plan-window-waiting-dot" />
          {t('planReview.waiting', 'Waiting for your decision')}
        </span>
        <span className="plan-window-header-spacer" />
        {!collapsed && (
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
        <button
          type="button"
          className="plan-window-header-btn plan-window-icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? t('planReview.expand', 'Expand') : t('planReview.collapse', 'Collapse to title bar')}
          aria-label={collapsed ? t('planReview.expand', 'Expand') : t('planReview.collapse', 'Collapse to title bar')}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {!collapsed && (
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

          <div
            className="plan-window-resize"
            onPointerDown={startGesture('resize')}
            title={t('planReview.resizeHint', 'Drag to resize this window')}
          />
        </>
      )}
    </div>
  );
}
