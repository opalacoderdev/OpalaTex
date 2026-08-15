import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderConnectionForm from './ProviderConnectionForm';

const NEW_CONNECTION_VALUE = '__new_connection__';

/**
 * Model registration fields shared by the Add Model modal and the onboarding
 * flow: pick an already-registered provider connection (label/API key/base
 * URL) and just type the model name, instead of retyping credentials for
 * every model.
 *
 * When there are no connections yet (a brand new install, before onboarding
 * has registered one) the inline "new connection" fields auto-expand so the
 * very first model can still be registered in one flow.
 *
 * Owns the catalog entry rules so they exist in one place only: required
 * connection/name, duplicate detection against the existing catalog scoped
 * to the selected connection, and id generation (`provider/name`, suffixed
 * with the connection id when that base id is already taken by a different
 * connection's model of the same name).
 */
export default function ModelForm({
  editingModel,
  existingModels = [],
  connections = [],
  onSubmit,
  onSaveConnection,
  actions,
  formStyle,
}) {
  const { t } = useTranslation();

  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('');
  const [supportsThinking, setSupportsThinking] = useState(false);
  const [error, setError] = useState('');
  const [showNewConnection, setShowNewConnection] = useState(connections.length === 0);

  useEffect(() => {
    if (editingModel) {
      setConnectionId(editingModel.connection_id || '');
      setName(editingModel.name || '');
      setSupportsThinking(!!editingModel.supports_thinking);
      setShowNewConnection(false);
    } else {
      setSupportsThinking(false);
      setShowNewConnection(connections.length === 0);
    }
  }, [editingModel]);

  useEffect(() => {
    if (!editingModel && connections.length === 0) {
      setShowNewConnection(true);
    }
  }, [connections.length, editingModel]);

  const reset = () => {
    setConnectionId('');
    setName('');
    setSupportsThinking(false);
    setError('');
    setShowNewConnection(connections.length === 0);
  };

  const handleConnectionChange = (e) => {
    const val = e.target.value;
    if (val === NEW_CONNECTION_VALUE) {
      setShowNewConnection(true);
      setConnectionId('');
    } else {
      setShowNewConnection(false);
      setConnectionId(val);
    }
  };

  const handleNewConnectionSubmit = async (connectionData) => {
    setError('');
    const result = await onSaveConnection(connectionData);
    if (!result || result.ok === false) {
      setError(result?.error || t('connectionForm.requiredError'));
      return;
    }
    setConnectionId(connectionData.id);
    setShowNewConnection(false);
  };

  const selectedConnection = connections.find(c => c.id === connectionId);

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();

    if (!connectionId || !trimmedName) {
      setError(t('modelForm.requiredError'));
      return;
    }

    const duplicate = existingModels.some(model =>
      model.id !== editingModel?.id &&
      model.connection_id === connectionId &&
      model.name === trimmedName
    );

    if (duplicate) {
      setError(t('modelForm.duplicateError'));
      return;
    }

    const provider = selectedConnection?.provider || '';
    const baseId = `${provider}/${trimmedName}`;
    const id = existingModels.some(model => model.id !== editingModel?.id && model.id === baseId)
      ? `${baseId}#${connectionId}`
      : baseId;

    onSubmit({
      id,
      previous_id: editingModel?.id,
      connection_id: connectionId,
      name: trimmedName,
      supports_thinking: supportsThinking,
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
          <label>{t('modelForm.connectionLabel')}</label>
          {connections.length > 0 && (
            <select
              className="vscode-settings-input"
              value={showNewConnection ? NEW_CONNECTION_VALUE : connectionId}
              onChange={handleConnectionChange}
            >
              <option value="">{t('modelForm.connectionPlaceholder')}</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.label || c.provider} ({c.provider})
                </option>
              ))}
              <option value={NEW_CONNECTION_VALUE}>{t('modelForm.newConnectionOption')}</option>
            </select>
          )}

          {showNewConnection && (
            <div style={{ marginTop: '12px', padding: '12px', border: '1px dashed var(--vscode-widget-border)', borderRadius: '4px' }}>
              <ProviderConnectionForm
                asForm={false}
                existingConnections={connections}
                onSubmit={handleNewConnectionSubmit}
                onCancel={connections.length > 0 ? () => setShowNewConnection(false) : undefined}
                submitLabel={t('modelForm.saveConnectionBtn')}
              />
            </div>
          )}
        </div>

        <div className="vscode-form-group">
          <label>{t('modelForm.modelNameLabel')}</label>
          <input
            type="text"
            className="vscode-settings-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('modelForm.modelNamePlaceholder')}
          />
        </div>

        <div className="vscode-form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={supportsThinking}
              onChange={e => setSupportsThinking(e.target.checked)}
            />
            {t('modelForm.supportsThinkingLabel')}
          </label>
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
            {t('modelForm.supportsThinkingHint')}
          </span>
        </div>

        {(selectedConnection && name) && (
          <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
            {t('modelForm.generatedId')}: <strong style={{ color: '#ccc' }}>{selectedConnection.provider}/{name.trim()}</strong>
          </div>
        )}
      </div>

      {actions}
    </form>
  );
}
