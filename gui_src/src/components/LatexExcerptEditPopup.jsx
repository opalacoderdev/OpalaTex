import React, { useEffect, useRef } from 'react';
import {
  Wand2,
  X,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Send,
  Check,
  PenLine,
  Undo2,
  Code2,
  AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  TEXT_SCALE_STEP,
  useFloatingPosition,
  useRememberedTextScale,
} from '../hooks/useFloatingPopup';
import { TEXT_SCALE_STORAGE_KEY } from './TranslationPopup';
import { formatLookupSource } from '../utils/snippetQueryExport';

/**
 * Floating card for "Edit excerpt…" in a PDF associated with LaTeX.
 *
 * Follows SnippetQueryPopup's interaction model: movable by its header,
 * remembers text zoom, never dismisses on an outside click (so the user never
 * loses a typed instruction or reviewed diff), and requires explicit
 * confirmation of the proposed diff before writing to disk and recompiling.
 */
export default function LatexExcerptEditPopup({
  state,
  standaloneAnnotationCount = 0,
  onClose,
  onInstructionChange,
  onPropose,
  onApply,
  onRevert,
  onCompose,
  onOpenSource,
}) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const instructionRef = useRef(null);
  const [textScale, changeTextScale] = useRememberedTextScale(TEXT_SCALE_STORAGE_KEY);

  const status = state?.status;
  const busy = status === 'loading' || status === 'applying' || Boolean(state?.isReverting);

  const { position, isDragging, startDrag } = useFloatingPosition(popupRef, {
    anchor: state,
    anchorKey: state?.excerpt,
    measureKey: `${status}:${textScale}:${state?.proposal?.diffLines?.length || 0}:${state?.error?.length || 0}`,
  });

  useEffect(() => {
    if (status === 'compose') instructionRef.current?.focus();
  }, [status, state?.excerpt]);

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, busy, onClose]);

  if (!state) return null;

  const { excerpt, source, instruction, proposal, applyResult, error, isReverting } = state;
  const sourceLine = formatLookupSource(t, source);
  const canPropose = Boolean(String(instruction || '').trim());

  const targetFile = applyResult?.targetFile || proposal?.targetFile || '';
  const targetStartLine = applyResult?.startLine || proposal?.startLine || 1;
  const targetEndLine = applyResult?.endLine || proposal?.endLine || targetStartLine;
  const lineRangeLabel = targetStartLine === targetEndLine
    ? t('latexExcerptEdit.lineSingle', 'line {{line}}', { line: targetStartLine })
    : t('latexExcerptEdit.lineRange', 'lines {{start}}–{{end}}', { start: targetStartLine, end: targetEndLine });

  const footerButton = (key, Icon, label, onClick, { disabled = false, title, primary = false } = {}) => (
    <button
      key={key}
      type="button"
      className={`vscode-bottom-panel-clear-btn snippet-query-footer-btn${primary ? ' latex-edit-primary-btn' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <Icon size={12} className={Icon === RefreshCw && (busy || isReverting) ? 'animate-spin' : ''} />
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={popupRef}
      className={`snippet-translate-popup snippet-query-popup latex-edit-popup${isDragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-label={t('latexExcerptEdit.title', 'Edit LaTeX excerpt')}
      style={{ top: `${position.y}px`, left: `${position.x}px`, '--snippet-translate-text-scale': textScale }}
    >
      <div
        className={`snippet-translate-popup-header${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        title={t('translation.dragHint', 'Drag to move this window')}
      >
        <Wand2 size={14} />
        <span>{t('latexExcerptEdit.title', 'Edit LaTeX excerpt')}</span>
        <span className="snippet-translate-popup-header-spacer" />
        <button
          type="button"
          className="snippet-translate-popup-zoom-btn"
          onClick={() => changeTextScale(-TEXT_SCALE_STEP)}
          disabled={textScale <= MIN_TEXT_SCALE}
          title={t('translation.decreaseText', 'Decrease text size')}
          aria-label={t('translation.decreaseText', 'Decrease text size')}
        >
          <ZoomOut size={14} />
        </button>
        <span className="snippet-translate-popup-zoom-level" aria-live="polite">
          {Math.round(textScale * 100)}%
        </span>
        <button
          type="button"
          className="snippet-translate-popup-zoom-btn"
          onClick={() => changeTextScale(TEXT_SCALE_STEP)}
          disabled={textScale >= MAX_TEXT_SCALE}
          title={t('translation.increaseText', 'Increase text size')}
          aria-label={t('translation.increaseText', 'Increase text size')}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="snippet-translate-popup-close"
          onClick={onClose}
          disabled={busy}
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="snippet-translate-popup-body snippet-query-body">
        <span className="snippet-translate-popup-label">
          {t('translation.selectedExcerpt', 'Selected excerpt')}
          {sourceLine && <span className="snippet-query-source"> · {sourceLine}</span>}
        </span>
        <div className="snippet-translate-popup-source">{excerpt}</div>

        {status === 'compose' ? (
          <>
            <label className="snippet-translate-popup-label" htmlFor="latex-excerpt-edit-instruction">
              {t('latexExcerptEdit.instructionLabel', 'What would you like to change?')}
            </label>
            <textarea
              id="latex-excerpt-edit-instruction"
              ref={instructionRef}
              className="snippet-query-question-input"
              value={instruction}
              rows={3}
              placeholder={t(
                'latexExcerptEdit.instructionPlaceholder',
                'Describe the change you want in this excerpt...',
              )}
              onChange={(e) => onInstructionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (canPropose) onPropose();
                }
              }}
            />
            <span className="snippet-query-hint">
              {t(
                'latexExcerptEdit.sendHint',
                'Ctrl+Enter to generate a diff. Nothing is written or compiled until you confirm.',
              )}
            </span>
          </>
        ) : (
          <>
            <span className="snippet-translate-popup-label">
              {t('latexExcerptEdit.instructionLabel', 'What would you like to change?')}
            </span>
            <div className="snippet-query-question">{instruction}</div>
          </>
        )}

        {status === 'loading' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>
              {t(
                'latexExcerptEdit.loadingProposal',
                'Locating the passage in LaTeX source and preparing a diff...',
              )}
            </span>
          </div>
        )}

        {status === 'applying' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>
              {t(
                'latexExcerptEdit.applying',
                'Applying the change to {{file}} and recompiling PDF...',
                { file: targetFile },
              )}
            </span>
          </div>
        )}

        {isReverting && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>
              {t('latexExcerptEdit.reverting', 'Reverting {{file}} and recompiling PDF...', { file: targetFile })}
            </span>
          </div>
        )}

        {proposal && (status === 'review' || status === 'applying' || status === 'done') && (
          <>
            <div className="latex-edit-meta">
              <span className="latex-edit-target">
                {proposal.targetFile} · {lineRangeLabel}
              </span>
              <span className="latex-edit-counts">
                <span className="latex-edit-count-add">+{proposal.added}</span>
                {' / '}
                <span className="latex-edit-count-remove">-{proposal.removed}</span>
              </span>
            </div>

            {proposal.summary && (
              <div className="latex-edit-summary">{proposal.summary}</div>
            )}

            <div className="latex-edit-diff" role="region" aria-label={t('latexExcerptEdit.diffLabel', 'Proposed diff')}>
              {(proposal.diffLines || []).map((line, index) => (
                <div
                  key={index}
                  className={`latex-edit-diff-line is-${line.kind}`}
                >
                  {line.kind === 'header' ? (
                    <span className="latex-edit-diff-header-text">{line.text}</span>
                  ) : (
                    <>
                      <span className="latex-edit-diff-ln">{line.oldLine ?? ''}</span>
                      <span className="latex-edit-diff-ln">{line.newLine ?? ''}</span>
                      <span className="latex-edit-diff-sign">
                        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                      </span>
                      <span className="latex-edit-diff-text">{line.text}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {status === 'review' && standaloneAnnotationCount > 0 && (
          <div className="snippet-query-warning latex-edit-warning" role="status">
            <AlertTriangle size={12} />
            <span>
              {t(
                'latexExcerptEdit.annotationsWarning',
                'Recompiling replaces this PDF and discards its {{count}} embedded annotation(s).',
                { count: standaloneAnnotationCount },
              )}
            </span>
          </div>
        )}

        {status === 'done' && (
          <div className="snippet-query-saved" role="status">
            <Check size={12} />
            <span>
              {t(
                'latexExcerptEdit.appliedSuccess',
                'Applied to {{file}} and recompiled.',
                { file: targetFile },
              )}
            </span>
          </div>
        )}

        {status === 'compile_error' && (
          <div className="latex-edit-compile-error">
            <div className="snippet-translate-popup-error">
              {t(
                'latexExcerptEdit.compileFailed',
                'The edit was written to {{file}}, but LaTeX compilation failed. You can revert it or inspect the source.',
                { file: targetFile },
              )}
            </div>
            {applyResult?.compileLog && (
              <pre className="latex-edit-log">{applyResult.compileLog}</pre>
            )}
          </div>
        )}

        {error && status !== 'compile_error' && (
          <div className="snippet-translate-popup-error">
            {status === 'error'
              ? t('latexExcerptEdit.failed', 'Could not prepare the edit: {{error}}', { error })
              : error}
          </div>
        )}
      </div>

      <div className="snippet-translate-popup-footer snippet-query-footer">
        {status === 'compose' && footerButton(
          'propose',
          Send,
          t('latexExcerptEdit.generateDiff', 'Preview diff'),
          onPropose,
          {
            disabled: !canPropose,
            primary: true,
            title: canPropose ? undefined : t('latexExcerptEdit.needsInstruction', 'Describe the change first.'),
          },
        )}

        {status === 'error' && (
          <>
            {footerButton('retry', RefreshCw, t('translation.retry', 'Try again'), onPropose)}
            {footerButton('edit', PenLine, t('latexExcerptEdit.editInstruction', 'Edit request'), () => onCompose(true))}
          </>
        )}

        {status === 'review' && (
          <>
            {footerButton(
              'apply',
              Check,
              t('latexExcerptEdit.applyAndCompile', 'Apply & compile'),
              onApply,
              { primary: true },
            )}
            {footerButton('edit', PenLine, t('latexExcerptEdit.editInstruction', 'Edit request'), () => onCompose(true))}
            {footerButton('cancel', X, t('common.cancel', 'Cancel'), onClose)}
          </>
        )}

        {status === 'done' && (
          <>
            {footerButton(
              'undo',
              Undo2,
              t('latexExcerptEdit.undo', 'Undo'),
              onRevert,
              { disabled: isReverting },
            )}
            {onOpenSource && targetFile && footerButton(
              'openSource',
              Code2,
              t('latexExcerptEdit.openSource', 'Open source'),
              () => {
                onOpenSource(targetFile, targetStartLine);
                onClose();
              },
            )}
            {footerButton('close', X, t('common.close', 'Close'), onClose)}
          </>
        )}

        {status === 'compile_error' && (
          <>
            {footerButton(
              'revert',
              Undo2,
              t('latexExcerptEdit.revertEdit', 'Revert edit'),
              onRevert,
              { disabled: isReverting, primary: true },
            )}
            {onOpenSource && targetFile && footerButton(
              'openSource',
              Code2,
              t('latexExcerptEdit.openSource', 'Open source'),
              () => {
                onOpenSource(targetFile, targetStartLine);
                onClose();
              },
            )}
            {footerButton('close', X, t('common.close', 'Close'), onClose)}
          </>
        )}
      </div>
    </div>
  );
}
