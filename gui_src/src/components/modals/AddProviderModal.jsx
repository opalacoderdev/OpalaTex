import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function AddProviderModal({
  editingModel,
  onClose,
  onSave
}) {
  const { t } = useTranslation();
  
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (editingModel) {
      setProvider(editingModel.provider || '');
      setName(editingModel.name || '');
      setApiKey(editingModel.api_key || '');
      setApiBase(editingModel.api_base || '');
    }
  }, [editingModel]);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    if (!provider || !name) {
      setError('Provider and Model Name are required.');
      return;
    }

    const id = `${provider}/${name}`;
    
    onSave({
      id,
      provider,
      name,
      api_key: apiKey,
      api_base: apiBase
    });
  };

  return (
    <div className="vscode-modal-overlay" onClick={onClose}>
      <div className="vscode-modal" style={{ width: '450px' }} onClick={e => e.stopPropagation()}>
        <div className="vscode-modal-header">
          <h2>{editingModel ? 'Edit Model' : 'Add Model / Provider'}</h2>
          <button onClick={onClose} className="vscode-modal-close"><X size={16} /></button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="vscode-modal-content" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {error && (
              <div style={{ color: '#f48771', fontSize: '12px', padding: '8px', background: 'rgba(244,135,113,0.1)', borderRadius: '4px' }}>
                {error}
              </div>
            )}
            
            <div className="vscode-form-group">
              <label>Provider (e.g., ollama, gemini, openai) *</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={provider}
                onChange={e => setProvider(e.target.value)}
                placeholder="ollama"
                disabled={!!editingModel}
              />
              {editingModel && <span style={{fontSize:'11px', color:'#888'}}>Provider cannot be changed during edit.</span>}
            </div>

            <div className="vscode-form-group">
              <label>Model Name (e.g., gemma4:12b) *</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="gemma4:12b"
                disabled={!!editingModel}
              />
              {editingModel && <span style={{fontSize:'11px', color:'#888'}}>Model Name cannot be changed during edit.</span>}
            </div>

            <div className="vscode-form-group">
              <label>API Key (Optional)</label>
              <input
                type="password"
                className="vscode-settings-input"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>

            <div className="vscode-form-group">
              <label>API Base URL (Optional)</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={apiBase}
                onChange={e => setApiBase(e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
            </div>
            
            {(!editingModel && provider && name) && (
              <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                Generated ID: <strong style={{color:'#ccc'}}>{provider}/{name}</strong>
              </div>
            )}
          </div>
          
          <div className="vscode-modal-footer">
            <button type="button" className="vscode-button-secondary" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button type="submit" className="vscode-button">
              <Save size={14} /> {t('common.save', 'Save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
