import React, { useState } from 'react';
import { X, Search, Plus, Trash2, Edit2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function EditModelsModal({
  globalModels,
  onClose,
  onDeleteModel,
  onEditModel,
  onAddProvider
}) {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredModels = globalModels.filter(m => 
    (m.id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (m.provider || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (m.name || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="vscode-modal-overlay" onClick={onClose}>
      <div className="vscode-modal" style={{ width: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="vscode-modal-header">
          <h2>Edit Models / Providers</h2>
          <button onClick={onClose} className="vscode-modal-close"><X size={16} /></button>
        </div>
        
        <div className="vscode-modal-content" style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, minHeight: 0 }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: '#888' }} />
              <input
                type="text"
                className="vscode-settings-input"
                placeholder="Search models..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{ width: '100%', paddingLeft: '28px' }}
              />
            </div>
            <button className="vscode-button" onClick={onAddProvider}>
              <Plus size={14} /> Add Provider/Model
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--vscode-widget-border)', borderRadius: '4px' }}>
            {filteredModels.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                No models found.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--vscode-widget-border)', background: 'var(--vscode-editor-inactiveSelectionBackground)' }}>
                    <th style={{ padding: '8px', textAlign: 'left' }}>Provider</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>Model Name</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>ID</th>
                    <th style={{ padding: '8px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map((model) => (
                    <tr key={model.id} style={{ borderBottom: '1px solid var(--vscode-widget-border)' }}>
                      <td style={{ padding: '8px' }}>{model.provider}</td>
                      <td style={{ padding: '8px' }}>{model.name}</td>
                      <td style={{ padding: '8px', color: '#888' }}>{model.id}</td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        <button 
                          className="vscode-bottom-panel-clear-btn" 
                          title="Edit"
                          onClick={() => onEditModel(model)}
                          style={{ padding: '4px', marginRight: '4px' }}
                        >
                          <Edit2 size={14} />
                        </button>
                        <button 
                          className="vscode-bottom-panel-clear-btn" 
                          title="Delete"
                          onClick={() => {
                            if(window.confirm(`Are you sure you want to delete ${model.id}?`)) {
                              onDeleteModel(model.id);
                            }
                          }}
                          style={{ padding: '4px', color: '#f48771' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        
        <div className="vscode-modal-footer">
          <button className="vscode-button-secondary" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
