import React from 'react';
import { FolderOpen, Folder, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Modal for browsing and selecting a directory from the filesystem.
export default function DirPickerModal({ dirPicker, onNavigate, onConfirm, onClose }) {
  const { t } = useTranslation();

  if (!dirPicker) return null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#1e1e1e', border: '1px solid #3c3c3c', borderRadius: '6px', padding: '16px', width: '480px', maxHeight: '60vh', display: 'flex', flexDirection: 'column', gap: '10px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div style={{ color: '#cccccc', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FolderOpen size={15} style={{ color: '#e8a838' }} />
          {t('dirPickerModal.title')}
        </div>

        {/* Current path */}
        <div style={{ background: '#252526', border: '1px solid #3c3c3c', borderRadius: '3px', padding: '5px 8px', fontSize: '12px', color: '#9cdcfe', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {dirPicker.current}
        </div>

        {/* Directory list */}
        <div style={{ overflowY: 'auto', flex: 1, border: '1px solid #3c3c3c', borderRadius: '3px', background: '#252526' }}>
          {dirPicker.dirs.length === 0 && (
            <div style={{ color: '#808080', fontSize: '12px', padding: '12px', textAlign: 'center' }}>{t('dirPickerModal.noSubdirs')}</div>
          )}
          {dirPicker.dirs.map(d => (
            <div
              key={d.path}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', cursor: 'pointer', fontSize: '12px', color: '#cccccc', borderBottom: '1px solid #2d2d2d' }}
              onMouseEnter={e => e.currentTarget.style.background = '#2a2d2e'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => onNavigate(d.path)}
            >
              <Folder size={13} style={{ color: '#e8a838', flexShrink: 0 }} />
              <span style={{ fontFamily: 'monospace' }}>{d.name}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <button type="button" className="vscode-button" style={{ background: '#3c3c3c', fontSize: '12px' }} onClick={onClose}>
            {t('dirPickerModal.cancel')}
          </button>
          <button type="button" className="vscode-button" style={{ fontSize: '12px' }} onClick={onConfirm}>
            <Check size={12} /> {t('dirPickerModal.selectFolder')}
          </button>
        </div>
      </div>
    </div>
  );
}
