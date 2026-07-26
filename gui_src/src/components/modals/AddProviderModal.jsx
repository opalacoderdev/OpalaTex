import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function AddProviderModal({
  editingModel,
  existingModels = [],
  onClose,
  onSave
}) {
  const { t } = useTranslation();
  
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [supportsThinking, setSupportsThinking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editingModel) {
      setProvider(editingModel.provider || '');
      setName(editingModel.name || '');
      setApiKey(editingModel.api_key || '');
      setApiBase(editingModel.api_base || '');
      setSupportsThinking(!!editingModel.supports_thinking);
    } else {
      setSupportsThinking(false);
    }
  }, [editingModel]);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    const trimmedProvider = provider.trim();
    const trimmedName = name.trim();

    if (!trimmedProvider || !trimmedName) {
      setError(t('addProviderModal.requiredError'));
      return;
    }

    const id = `${trimmedProvider}/${trimmedName}`;
    const duplicate = existingModels.some(model =>
      model.id === id && model.id !== editingModel?.id
    );

    if (duplicate) {
      setError(t('addProviderModal.duplicateError'));
      return;
    }
    
    onSave({
      id,
      previous_id: editingModel?.id,
      provider: trimmedProvider,
      name: trimmedName,
      api_key: apiKey,
      api_base: apiBase,
      supports_thinking: supportsThinking
    });
  };

  return (
    <div className="vscode-modal-overlay" onClick={onClose}>
      <div className="vscode-modal" style={{ width: '450px' }} onClick={e => e.stopPropagation()}>
        <div className="vscode-modal-header">
          <h2>{editingModel ? t('addProviderModal.editTitle') : t('addProviderModal.addTitle')}</h2>
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
              <label>{t('addProviderModal.providerLabel')}</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={provider}
                onChange={e => setProvider(e.target.value)}
                placeholder="ollama"
                disabled={!!editingModel}
              />
              {editingModel && <span style={{fontSize:'11px', color:'#888'}}>{t('addProviderModal.providerLocked')}</span>}
            </div>

            <div className="vscode-form-group">
              <label>{t('addProviderModal.modelNameLabel')}</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="gemma4:12b"
              />
            </div>

            <div className="vscode-form-group">
              <label>{t('addProviderModal.apiKeyLabel')}</label>
              <input
                type="password"
                className="vscode-settings-input"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>

            <div className="vscode-form-group">
              <label>{t('addProviderModal.apiBaseLabel')}</label>
              <input
                type="text"
                className="vscode-settings-input"
                value={apiBase}
                onChange={e => setApiBase(e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
            </div>

            <div className="vscode-form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={supportsThinking}
                  onChange={e => setSupportsThinking(e.target.checked)}
                />
                {t('addProviderModal.supportsThinkingLabel')}
              </label>
              <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                {t('addProviderModal.supportsThinkingHint')}
              </span>
            </div>
            
            {(provider && name) && (
              <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                {t('addProviderModal.generatedId')}: <strong style={{color:'#ccc'}}>{provider.trim()}/{name.trim()}</strong>
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
