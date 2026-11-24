import React from 'react';
import { Copy, Scissors, Clipboard, CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ContextMenuSurface from './ContextMenuSurface';
import SnippetActions from './SnippetActions';

/**
 * Right-click menu for text surfaces (the chat history, the bottom panel,
 * LaTeX Rich Text and WYSIWYG editors).
 *
 * Copy (and Cut, when offered) require a non-empty selection and stay disabled
 * while nothing is selected. The excerpt actions are optional: a surface that
 * passes `onTranslate` gets the same *Ask about* / *Translate* / *Pronounce*
 * items the document viewers offer (§2.13), from the same component, so the
 * menus cannot drift.
 *
 * `menu` carries the excerpt captured at right-click time (`useTextContextMenu`),
 * because pressing an item can collapse the selection.
 */
export default function TextContextMenu({
  menu,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  canCut = true,
  canPaste = true,
  onAskAbout,
  onLookUp,
  onTranslate,
  onPronounce,
  canAsk = true,
  canPronounce = false,
  pronounceUnavailableHint = '',
}) {
  const { t } = useTranslation();

  if (!menu) return null;

  const hasSnippetActions = Boolean(onTranslate);
  const hasSelection = Boolean(menu.selectedText);
  const needsSelection = t('snippetActions.needsSelection', 'Select some text first.');
  const cutEnabled = hasSelection && canCut;

  return (
    <ContextMenuSurface
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      ariaLabel={t('textContextMenu.label', 'Text actions')}
    >
      {onCut && (
        <div
          className={`vscode-context-menu-item${cutEnabled ? '' : ' vscode-context-menu-item-disabled'}`}
          role="menuitem"
          aria-disabled={!cutEnabled}
          title={hasSelection ? undefined : needsSelection}
          onClick={() => { if (cutEnabled) onCut(menu); }}
        >
          <Scissors size={13} />
          <span>{t('contextMenu.cut', 'Cut')}</span>
        </div>
      )}
      {onCopy && (
        <div
          className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
          role="menuitem"
          aria-disabled={!hasSelection}
          title={hasSelection ? undefined : needsSelection}
          onClick={() => { if (hasSelection) onCopy(menu); }}
        >
          <Copy size={13} />
          <span>{t('textContextMenu.copy', 'Copy')}</span>
        </div>
      )}
      {onPaste && (
        <div
          className={`vscode-context-menu-item${canPaste ? '' : ' vscode-context-menu-item-disabled'}`}
          role="menuitem"
          aria-disabled={!canPaste}
          onClick={() => { if (canPaste) onPaste(menu); }}
        >
          <Clipboard size={13} />
          <span>{t('textContextMenu.paste', 'Paste')}</span>
        </div>
      )}
      {onSelectAll && (
        <div
          className="vscode-context-menu-item"
          role="menuitem"
          onClick={() => onSelectAll(menu)}
        >
          <CheckSquare size={13} />
          <span>{t('textContextMenu.selectAll', 'Select All')}</span>
        </div>
      )}

      {hasSnippetActions && (
        <>
          <div className="vscode-context-menu-separator" role="separator" />
          <SnippetActions
            hasSelection={hasSelection}
            canAsk={canAsk && Boolean(onAskAbout)}
            canPronounce={canPronounce}
            pronounceUnavailableHint={pronounceUnavailableHint}
            onAskAbout={() => onAskAbout?.(menu)}
            onLookUp={onLookUp ? (() => onLookUp(menu)) : undefined}
            onTranslate={() => onTranslate(menu)}
            onPronounce={onPronounce ? (() => onPronounce(menu)) : undefined}
          />
        </>
      )}
    </ContextMenuSurface>
  );
}
