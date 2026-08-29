import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Languages, X, Copy, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { safeGetLocalStorage, safeSetLocalStorage } from '../utils/storage';

// Text scale of the popup, kept between 80% and 240% so the excerpt stays
// readable without the popup growing past its own scroll area. The choice is
// persisted: someone who needs larger text needs it every time.
const MIN_TEXT_SCALE = 0.8;
const MAX_TEXT_SCALE = 2.4;
const TEXT_SCALE_STEP = 0.15;
const TEXT_SCALE_STORAGE_KEY = 'pdfTranslationTextScale';

// Gap kept between the popup and the window edges, both when it opens and while
// it is dragged, so the header (and therefore the drag handle) never goes
// off-screen where it could not be grabbed back.
const VIEWPORT_MARGIN = 8;

const clampTextScale = (value) => (
  Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(value * 100) / 100))
);

/**
 * Floating popup that shows the translation of a PDF excerpt.
 *
 * `state` is { x, y, sourceText, status, targetLanguage, translatedText,
 * error } or null when the popup is closed. The parent owns the
 * request; this component only renders whichever phase the request is in.
 */
export default function PdfTranslationPopup({ state, onClose, onRetry, onCopy }) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const [textScale, setTextScale] = useState(() => {
    const stored = Number(safeGetLocalStorage(TEXT_SCALE_STORAGE_KEY, '1'));
    return Number.isFinite(stored) && stored > 0 ? clampTextScale(stored) : 1;
  });

  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragGrabRef = useRef(null);

  const changeTextScale = (delta) => {
    setTextScale((prev) => {
      const next = clampTextScale(prev + delta);
      safeSetLocalStorage(TEXT_SCALE_STORAGE_KEY, String(next));
      return next;
    });
  };

  // A new translation re-anchors the popup at the click that asked for it. A
  // retry reuses the same coordinates and the same excerpt, so a popup the user
  // has already dragged somewhere comfortable stays put.
  //
  // This must be a layout effect, and must be declared before the viewport
  // clamp below: as a passive effect it would run *after* the clamp had already
  // painted the popup at its previous (or initial) coordinates for one frame.
  useLayoutEffect(() => {
    if (!state) return;
    setPosition({ x: state.x, y: state.y });
  }, [state?.x, state?.y, state?.sourceText]);

  const startDrag = (e) => {
    // Only the header background drags; the zoom and close buttons still click.
    if (e.button !== 0 || e.target.closest('button')) return;
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragGrabRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setIsDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return undefined;
    const handleMove = (e) => {
      const grab = dragGrabRef.current;
      if (!grab) return;
      setPosition({ x: e.clientX - grab.dx, y: e.clientY - grab.dy });
    };
    const endDrag = () => {
      dragGrabRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [isDragging]);

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClick = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('mousedown', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('mousedown', handleClick, true);
    };
  }, [state, onClose]);

  // Keep the popup inside the viewport — on open, whenever a phase or the text
  // scale changes its height, and on every drag step. Clamping is idempotent,
  // so re-running it on its own result settles in one pass.
  useLayoutEffect(() => {
    if (!state || !popupRef.current) return;
    const rect = popupRef.current.getBoundingClientRect();
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    setPosition((prev) => {
      const x = Math.min(Math.max(VIEWPORT_MARGIN, prev.x), maxX);
      const y = Math.min(Math.max(VIEWPORT_MARGIN, prev.y), maxY);
      return x === prev.x && y === prev.y ? prev : { x, y };
    });
  }, [state, state?.status, textScale, position]);

  if (!state) return null;

  const { status, sourceText, targetLanguage, translatedText, error } = state;

  return (
    <div
      ref={popupRef}
      className={`pdf-translate-popup${isDragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-label={t('pdfTranslation.title', 'Translation')}
      style={{ top: `${position.y}px`, left: `${position.x}px`, '--pdf-translate-text-scale': textScale }}
    >
      <div
        className={`pdf-translate-popup-header${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        title={t('pdfTranslation.dragHint', 'Drag to move this window')}
      >
        <Languages size={14} />
        <span>{t('pdfTranslation.title', 'Translation')}</span>
        <span className="pdf-translate-popup-header-spacer" />
        <button
          type="button"
          className="pdf-translate-popup-zoom-btn"
          onClick={() => changeTextScale(-TEXT_SCALE_STEP)}
          disabled={textScale <= MIN_TEXT_SCALE}
          title={t('pdfTranslation.decreaseText', 'Decrease text size')}
          aria-label={t('pdfTranslation.decreaseText', 'Decrease text size')}
        >
          <ZoomOut size={14} />
        </button>
        <span className="pdf-translate-popup-zoom-level" aria-live="polite">
          {Math.round(textScale * 100)}%
        </span>
        <button
          type="button"
          className="pdf-translate-popup-zoom-btn"
          onClick={() => changeTextScale(TEXT_SCALE_STEP)}
          disabled={textScale >= MAX_TEXT_SCALE}
          title={t('pdfTranslation.increaseText', 'Increase text size')}
          aria-label={t('pdfTranslation.increaseText', 'Increase text size')}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="pdf-translate-popup-close"
          onClick={onClose}
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="pdf-translate-popup-body">
        <span className="pdf-translate-popup-label">
          {t('pdfTranslation.selectedExcerpt', 'Selected excerpt')}
        </span>
        <div className="pdf-translate-popup-source">{sourceText}</div>

        {status === 'loading' && (
          <div className="pdf-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>{t('pdfTranslation.translatingTo', 'Translating to {{language}}...', { language: targetLanguage })}</span>
          </div>
        )}

        {status === 'error' && (
          <div className="pdf-translate-popup-error">
            {t('pdfTranslation.failed', 'Translation failed: {{error}}', { error })}
          </div>
        )}

        {status === 'done' && (
          <>
            <span className="pdf-translate-popup-label">
              {t('pdfTranslation.to', 'Translated to {{to}}', { to: targetLanguage })}
            </span>
            <div className="pdf-translate-popup-result">{translatedText}</div>
          </>
        )}
      </div>

      <div className="pdf-translate-popup-footer">
        {status === 'done' && (
          <button
            type="button"
            className="vscode-bottom-panel-clear-btn"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}
            onClick={() => onCopy(translatedText)}
          >
            <Copy size={12} />
            <span>{t('pdfTranslation.copy', 'Copy translation')}</span>
          </button>
        )}
        {status === 'error' && (
          <button
            type="button"
            className="vscode-bottom-panel-clear-btn"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}
            onClick={onRetry}
          >
            <RefreshCw size={12} />
            <span>{t('pdfTranslation.retry', 'Try again')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
