import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Provider/model registration fields shared by the Add Provider modal and the
 * onboarding flow.
 *
 * Owns the catalog entry rules so they exist in one place only: required
 * provider/name, duplicate detection against the existing catalog, and id
 * generation (`provider/name`, suffixed with the API base when the plain id is
 * already taken by a different entry).
 *
 * `actions` receives the rendered footer buttons so each host can place them in
 * its own layout.
 */
export default function ProviderForm({
  editingModel,
  existingModels = [],
  onSubmit,
  actions,
  formStyle,
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

  const reset = () => {
    setProvider('');
    setName('');
    setApiKey('');
    setApiBase('');
    setSupportsThinking(false);
    setError('');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    const trimmedProvider = provider.trim();
    const trimmedName = name.trim();

    if (!trimmedProvider || !trimmedName) {
      setError(t('addProviderModal.requiredError'));
      return;
    }

    const trimmedApiBase = apiBase.trim();
    const duplicate = existingModels.some(model =>
      model.id !== editingModel?.id &&
      model.provider === trimmedProvider &&
      model.name === trimmedName &&
      (model.api_base || '').trim() === trimmedApiBase
    );

    const baseId = `${trimmedProvider}/${trimmedName}`;
    const id = existingModels.some(model => model.id !== editingModel?.id && model.id === baseId)
      ? `${baseId}#${encodeURIComponent(trimmedApiBase || 'default')}`
      : baseId;

    if (duplicate) {
      setError(t('addProviderModal.duplicateError'));
      return;
    }

    onSubmit({
      id,
      previous_id: editingModel?.id,
      provider: trimmedProvider,
      name: trimmedName,
      api_key: apiKey,
      api_base: trimmedApiBase,
      supports_thinking: supportsThinking
    }, { reset });
  };

  return (
    <form onSubmit={handleSubmit} style={formStyle}>
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
            placeholder={t('addProviderModal.providerPlaceholder')}
          />
        </div>

        <div className="vscode-form-group">
          <label>{t('addProviderModal.modelNameLabel')}</label>
          <input
            type="text"
            className="vscode-settings-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('addProviderModal.modelNamePlaceholder')}
          />
        </div>

        <div className="vscode-form-group">
          <label>{t('addProviderModal.apiKeyLabel')}</label>
          <input
            type="password"
            className="vscode-settings-input"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={t('addProviderModal.apiKeyPlaceholder')}
          />
        </div>

        <div className="vscode-form-group">
          <label>{t('addProviderModal.apiBaseLabel')}</label>
          <input
            type="text"
            className="vscode-settings-input"
            value={apiBase}
            onChange={e => setApiBase(e.target.value)}
            placeholder={t('addProviderModal.apiBasePlaceholder')}
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
            {t('addProviderModal.generatedId')}: <strong style={{ color: '#ccc' }}>{provider.trim()}/{name.trim()}</strong>
          </div>
        )}
      </div>

      {actions}
    </form>
  );
}
