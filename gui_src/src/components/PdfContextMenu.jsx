import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { MessageSquareQuote, Languages, Highlighter, Underline, Strikethrough, StickyNote, Trash2, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Right-click context menu for the PDF viewer.
 *
 * `menu` is { x, y, selectedText, page, point, annotation } for the spot that was
 * right-clicked, or null when no menu is open. "Translate" and the markup tools
 * only apply to a selected excerpt, so they stay disabled while the selection is
 * empty. When the click landed on an existing annotation, `menu.annotation` holds
 * it and the menu leads with the actions for that mark.
 */

// Highlighter colors offered for a new mark. Kept deliberately short: a long
// palette turns a one-gesture action into a decision.
export const ANNOTATION_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];

export default function PdfContextMenu({
  menu,
  onClose,
  onAskAbout,
  onTranslate,
  canAsk = true,
  canAnnotate = false,
  annotationColor = ANNOTATION_COLORS[0],
  onAnnotate,
  onEditNote,
  onRemoveAnnotation,
}) {
  const { t } = useTranslation();
  const menuRef = useRef(null);

  // Close on click outside, on another right-click, or on Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('contextmenu', handleClick, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('contextmenu', handleClick, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [menu, onClose]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    // Compared in viewport pixels, written back as a CSS length inside the
    // zoomed app — see viewportPxToApp.
    const scale = readUiScale();
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${Math.max(4, viewportPxToApp(window.innerWidth - rect.width, scale) - 5)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${Math.max(4, viewportPxToApp(window.innerHeight - rect.height, scale) - 5)}px`;
    }
  }, [menu]);

  if (!menu) return null;

  const hasSelection = Boolean(menu.selectedText);
  const target = menu.annotation;
  // Marks written by other software can use subtypes this viewer cannot recreate.
  // They are shown, never offered for editing.
  const canEditTarget = Boolean(target && target.editable);

  const run = (action, ...args) => {
    onClose();
    action(menu, ...args);
  };

  const markupItem = (kind, Icon, labelKey, fallback) => (
    <div
      className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
      aria-disabled={!hasSelection}
      title={hasSelection ? undefined : t('pdfContextMenu.annotateNeedsSelection', 'Select some text in the PDF first.')}
      onClick={() => { if (hasSelection) run(onAnnotate, kind, annotationColor); }}
    >
      <Icon size={13} style={{ color: annotationColor }} />
      <span>{t(labelKey, fallback)}</span>
    </div>
  );

  return (
    <div
      ref={menuRef}
      className="vscode-context-menu"
      style={{ top: `${menu.y}px`, left: `${menu.x}px` }}
      // Pressing inside the menu must not move the caret, which would collapse the
      // PDF text selection the markup actions are about to annotate. The geometry
      // is captured on right-click anyway, but keeping the selection alive also
      // keeps it visible while the user picks a color, and lets a retry work.
      onMouseDown={(event) => event.preventDefault()}
    >
      {canAnnotate && target && (
        <>
          <div
            className={`vscode-context-menu-item${canEditTarget ? '' : ' vscode-context-menu-item-disabled'}`}
            aria-disabled={!canEditTarget}
            title={canEditTarget ? undefined : t('pdfContextMenu.annotationNotEditable', 'This annotation was made by other software and cannot be edited here.')}
            onClick={() => { if (canEditTarget) run(onEditNote); }}
          >
            <PenLine size={13} style={{ color: '#4daafc' }} />
            <span>{t('pdfContextMenu.editNote', 'Edit note')}</span>
          </div>
          <div
            className={`vscode-context-menu-item${canEditTarget ? '' : ' vscode-context-menu-item-disabled'}`}
            aria-disabled={!canEditTarget}
            onClick={() => { if (canEditTarget) run(onRemoveAnnotation); }}
          >
            <Trash2 size={13} style={{ color: '#f87171' }} />
            <span>{t('pdfContextMenu.removeAnnotation', 'Remove annotation')}</span>
          </div>
          <div className="vscode-context-menu-separator" role="separator" />
        </>
      )}

      {canAnnotate && (
        <>
          {markupItem('highlight', Highlighter, 'pdfContextMenu.highlight', 'Highlight')}
          <div className="pdf-annotation-swatches" role="group" aria-label={t('pdfContextMenu.highlightColor', 'Highlight color')}>
            {ANNOTATION_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`pdf-annotation-swatch${color === annotationColor ? ' pdf-annotation-swatch-active' : ''}`}
                style={{ background: color }}
                aria-label={color}
                disabled={!hasSelection}
                onClick={() => { if (hasSelection) run(onAnnotate, 'highlight', color); }}
              />
            ))}
          </div>
          {markupItem('underline', Underline, 'pdfContextMenu.underline', 'Underline')}
          {markupItem('strikeout', Strikethrough, 'pdfContextMenu.strikeout', 'Strike through')}
          <div
            className="vscode-context-menu-item"
            onClick={() => run(onEditNote)}
          >
            <StickyNote size={13} style={{ color: '#facc15' }} />
            <span>{t('pdfContextMenu.addNote', 'Add a note here')}</span>
          </div>
          <div className="vscode-context-menu-separator" role="separator" />
        </>
      )}

      <div
        className={`vscode-context-menu-item${canAsk ? '' : ' vscode-context-menu-item-disabled'}`}
        aria-disabled={!canAsk}
        onClick={() => { if (canAsk) run(onAskAbout); }}
      >
        <MessageSquareQuote size={13} style={{ color: '#007acc' }} />
        <span>
          {hasSelection
            ? t('pdfContextMenu.askAboutSelection', 'Ask about the selected excerpt')
            : t('pdfContextMenu.askAboutDocument', 'Ask about this document')}
        </span>
      </div>
      <div
        className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
        aria-disabled={!hasSelection}
        title={hasSelection ? undefined : t('pdfContextMenu.translateNeedsSelection', 'Select some text in the PDF first.')}
        onClick={() => { if (hasSelection) run(onTranslate); }}
      >
        <Languages size={13} style={{ color: '#4daafc' }} />
        <span>{t('pdfContextMenu.translate', 'Translate selection')}</span>
      </div>
    </div>
  );
}
