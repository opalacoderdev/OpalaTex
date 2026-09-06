// ─────────────────────────────────────────────────────────────────────────────
// SlideContextMenu.jsx
//
// The right-click menu on the slide canvas.
//
// It reuses the IDE's `.vscode-context-menu` chrome rather than growing a look
// of its own: this menu floats above the slide but belongs to the application,
// so it follows the app theme exactly as the file explorer's menu does. (The
// editing chrome *on* the slide is the opposite case and carries explicit
// colours — the slide is white in every theme.)
//
// Paste is never disabled. Whether the system clipboard holds something usable
// cannot be known without reading it, and reading it is asynchronous; greying
// the item out on a guess would hide a perfectly good paste — an image copied
// in another application, most obviously. The item is always offered and does
// nothing when the clipboard turns out to be empty.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Copy, CopyPlus, Scissors, Trash2 } from 'lucide-react';

import { readUiScale, viewportPxToApp } from '../utils/uiScale.js';

export default function SlideContextMenu({
  menu,              // { x, y, elementId } in app CSS pixels, or null
  onCopy,
  onCut,
  onDuplicate,
  onPaste,
  onDelete,
  onClose,
}) {
  const { t } = useTranslation();
  const menuRef = useRef(null);

  // Same correction as the file explorer's menu: the rect and the viewport are
  // both measured in real pixels, but the position is written back as a CSS
  // length inside the app's zoom, so it has to cross that boundary.
  useLayoutEffect(() => {
    if (!menuRef.current || !menu) return;
    const scale = readUiScale();
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${viewportPxToApp(window.innerHeight - rect.height - 5, scale)}px`;
    }
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${viewportPxToApp(window.innerWidth - rect.width - 5, scale)}px`;
    }
  }, [menu]);

  // The menu closes on any click outside it, on Escape, and on a scroll or
  // resize that would leave it pointing at a place the user is no longer
  // looking at.
  useLayoutEffect(() => {
    if (!menu) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      onClose?.();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const hasElement = !!menu.elementId;
  const run = (action) => (event) => {
    event.stopPropagation();
    onClose?.();
    action?.();
  };

  const item = (key, label, Icon, action, enabled) => (
    <div
      className={`vscode-context-menu-item${enabled ? '' : ' vscode-context-menu-item-disabled'}`}
      data-testid={`deck-menu-${key}`}
      onClick={enabled ? run(action) : (event) => event.stopPropagation()}
    >
      <Icon size={13} />
      <span>{label}</span>
    </div>
  );

  return (
    <div
      ref={menuRef}
      className="vscode-context-menu"
      data-testid="deck-context-menu"
      style={{ top: `${menu.y}px`, left: `${menu.x}px` }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {item('cut', t('deck.cut'), Scissors, onCut, hasElement)}
      {item('copy', t('deck.copy'), Copy, onCopy, hasElement)}
      {item('duplicate', t('deck.duplicate'), CopyPlus, onDuplicate, hasElement)}
      {item('paste', t('deck.paste'), ClipboardPaste, onPaste, true)}
      <div className="vscode-context-menu-separator" />
      {item('delete', t('deck.deleteElement'), Trash2, onDelete, hasElement)}
    </div>
  );
}
