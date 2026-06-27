import { useState, useCallback, useEffect } from 'react';
import { readClipboard } from '../utils/clipboard.js';

export function useTextContextMenu() {
  const [menu, setMenu] = useState(null);

  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    // Close on outside click (capture phase so menu items can call their handlers first)
    const onPointerDown = (e) => {
      const menuEl = document.getElementById('text-context-menu');
      if (menuEl && menuEl.contains(e.target)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('contextmenu', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('contextmenu', close, true);
    };
  }, [menu, close]);

  const handleCopy = useCallback(() => {
    const sel = window.getSelection()?.toString();
    if (sel) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(sel).catch(() => document.execCommand('copy'));
      } else {
        document.execCommand('copy');
      }
    }
    close();
  }, [close]);

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
