import { useState, useCallback, useRef } from 'react';
import { viewportPointToApp } from '../utils/uiScale';
import { readClipboard, writeClipboard } from '../utils/clipboard.js';
import { readSelectionWithin } from '../utils/documentSelection.js';

export function useTextContextMenu(options = {}) {
  const [menu, setMenu] = useState(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // The excerpt is captured here, not when a menu item is pressed: pressing
    // one can collapse the selection, so a handler reading it then would find
    // nothing. It is scoped to the element the menu was opened on by default
    // (utils/documentSelection.js), or read through a surface-specific reader
    // (e.g. xterm or ProseMirror).
    const { getSelection, getMeta } = optionsRef.current;
    const selectedText = getSelection
      ? String(getSelection(e) || '')
      : readSelectionWithin(e.currentTarget);
    const meta = getMeta ? (getMeta(e, selectedText) || {}) : {};
    // Positioned with left/top inside the zoomed app — see viewportPointToApp.
    setMenu({ ...viewportPointToApp(e.clientX, e.clientY), selectedText, ...meta });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  const handleCopy = useCallback(() => {
    const text = menu?.selectedText || '';
    if (!text) return;
    writeClipboard(text);
    close();
  }, [menu, close]);

  const handlePaste = useCallback(() => {
    readClipboard().then((text) => {
      if (text) document.execCommand('insertText', false, text);
    });
    close();
  }, [close]);

  const handleSelectAll = useCallback((containerRef) => {
    if (containerRef?.current) {
      const range = document.createRange();
      range.selectNodeContents(containerRef.current);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    close();
  }, [close]);

  return { menu, onContextMenu, handleCopy, handlePaste, handleSelectAll, close };
}
