import React from 'react';
import { Copy, Clipboard, CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function TextContextMenu({ menu, onCopy, onCut, onPaste, onSelectAll }) {
  const { t } = useTranslation();

  if (!menu) return null;

  return (
    <div
      id="text-context-menu"
      className="vscode-context-menu"
      style={{ top: `${menu.y}px`, left: `${menu.x}px` }}
    >
      <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onCopy(); }}>
        <Copy size={13} />
        <span>{t('textContextMenu.copy')}</span>
      </div>
      <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onPaste(); }}>
        <Clipboard size={13} />
        <span>{t('textContextMenu.paste')}</span>
      </div>
      {onSelectAll && (
        <div className="vscode-context-menu-item" onPointerDown={(e) => { e.stopPropagation(); onSelectAll(); }}>
          <CheckSquare size={13} />
          <span>{t('textContextMenu.selectAll')}</span>
        </div>
      )}
    </div>
  );
}
