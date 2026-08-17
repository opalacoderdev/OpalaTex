import React, { useState } from 'react';
import { X, Search, Plus, Trash2, Edit2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './CustomDialogProvider';

export default function EditModelsModal({
  globalModels,
  onClose,
  onDeleteModel,
  onEditModel,
  onAddModel,
  onManageConnections,
  onLoadLocalOllama
}) {
  const { t } = useTranslation();
  const { showConfirm } = useCustomDialog();
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoadingLocalOllama, setIsLoadingLocalOllama] = useState(false);
  const [localOllamaResult, setLocalOllamaResult] = useState(null);

  const handleLoadLocalOllama = async () => {
    setIsLoadingLocalOllama(true);
    setLocalOllamaResult(null);
    try {
      setLocalOllamaResult(await onLoadLocalOllama());
    } finally {
      setIsLoadingLocalOllama(false);
    }
  };

  const localOllamaResultText = () => {
    if (!localOllamaResult) return '';
    if (localOllamaResult.status === 'loaded') {
      return localOllamaResult.count > 0
        ? t('editModelsModal.localOllamaLoaded', { count: localOllamaResult.count })
        : t('editModelsModal.localOllamaAlreadyConfigured');
    }
    if (localOllamaResult.status === 'ollama_not_installed') {
      return t('editModelsModal.ollamaNotInstalled');
    }
    if (localOllamaResult.status === 'ollama_unavailable') {
      return t('editModelsModal.ollamaUnavailable');
    }
    return t('editModelsModal.loadLocalOllamaFailed');
  };


  const filteredModels = globalModels.filter(m => 
    (m.id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (m.provider || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (m.name || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="vscode-modal-overlay" onClick={onClose}>
      <div className="vscode-modal" style={{ width: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="vscode-modal-header">
          <h2>{t('editModelsModal.title')}</h2>
          <button onClick={onClose} className="vscode-modal-close"><X size={16} /></button>
        </div>
        
        <div className="vscode-modal-content" style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, minHeight: 0 }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--vscode-descriptionForeground)' }} />
              <input
                type="text"
                className="vscode-settings-input"
                placeholder={t('editModelsModal.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{ width: '100%', paddingLeft: '28px' }}
              />
            </div>
            <button
              className="vscode-button-secondary"
              onClick={handleLoadLocalOllama}
              disabled={isLoadingLocalOllama}
            >
              <RefreshCw size={14} />
              {isLoadingLocalOllama
                ? t('editModelsModal.loadingLocalOllama')
                : t('editModelsModal.loadLocalOllama')}
            </button>
            <button className="vscode-button-secondary" onClick={onManageConnections}>
              {t('editModelsModal.manageConnections')}
            </button>
            <button className="vscode-button" onClick={onAddModel}>
              <Plus size={14} /> {t('editModelsModal.addProviderModel')}
            </button>
          </div>

          {localOllamaResult && (
            <div role="status" style={{ padding: '8px', border: '1px solid var(--vscode-widget-border)', background: 'var(--vscode-input-background)', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
              {localOllamaResultText()}
            </div>
          )}

          <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--vscode-widget-border)', borderRadius: '4px' }}>
            {filteredModels.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
                {t('editModelsModal.noModels')}
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--vscode-widget-border)', background: 'var(--vscode-editor-inactiveSelectionBackground)' }}>
                    <th style={{ padding: '8px', textAlign: 'left' }}>{t('editModelsModal.provider')}</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>{t('editModelsModal.modelName')}</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>ID</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>{t('editModelsModal.thinking')}</th>
                    <th style={{ padding: '8px', textAlign: 'left' }}>{t('modelForm.promptProfileLabel')}</th>
                    <th style={{ padding: '8px', textAlign: 'right' }}>{t('editModelsModal.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map((model) => (
                    <tr key={model.id} style={{ borderBottom: '1px solid var(--vscode-widget-border)' }} title={model.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${model.api_base}` : undefined}>
                      <td style={{ padding: '8px' }}>{model.connection_label || model.provider}</td>
                      <td style={{ padding: '8px' }}>{model.name}</td>
                      <td style={{ padding: '8px', color: 'var(--vscode-descriptionForeground)' }}>{model.id}</td>
                      <td style={{ padding: '8px', color: model.supports_thinking ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-descriptionForeground)' }}>
                        {model.supports_thinking ? t('common.yes', 'Yes') : t('common.no', 'No')}
                      </td>
                      <td style={{ padding: '8px', color: model.prompt_profile === 'light' ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-descriptionForeground)' }}>
                        {t(`modelForm.promptProfile.${model.prompt_profile === 'light' ? 'light' : 'full'}`)}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        <button 
                          className="vscode-icon-button"
                          title={t('common.edit')}
                          onClick={() => onEditModel(model)}
                        >
                          <Edit2 size={14} />
                        </button>
                        <button 
                          className="vscode-icon-button vscode-icon-button-danger"
                          title={t('common.delete')}
                          onClick={async () => {
                            if (await showConfirm(t('editModelsModal.deleteConfirm', { id: model.id }))) {
                              onDeleteModel(model.id);
                            }
                          }}
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
