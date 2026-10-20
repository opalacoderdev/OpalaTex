import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download, Plus, Trash2, X } from 'lucide-react';
import { PROVIDER_PRESETS, listProviderModels } from '../agent/providers.js';
import { getApiKey, setApiKey } from '../project/settings.js';
import { newId } from '../project/keys.js';

export default function Settings({ services, settings, onChange, onClose, onSignOut }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(services.auth.email);

  useEffect(() => {
    if (!email) services.drive.aboutUser().then((user) => setEmail(user.emailAddress || '')).catch(() => {});
  }, [services, email]);

  const updateConnection = (id, patch) => onChange({
    ...settings,
    connections: settings.connections.map((connection) => (connection.id === id ? { ...connection, ...patch } : connection)),
  });
  const addConnection = () => onChange({
    ...settings,
    connections: [...settings.connections, { id: newId(), provider: 'openai', name: '', baseUrl: '', models: [] }],
  });
  const removeConnection = async (id) => {
    await setApiKey(services.plugin, id, '');
    onChange({ ...settings, connections: settings.connections.filter((connection) => connection.id !== id) });
  };

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="icon" onClick={onClose} aria-label={t('app.back')}><ArrowLeft size={20} /></button>
        <h1>{t('settings.title')}</h1>
      </header>
      <main className="scroll pad settings">
        <section>
          <h2>{t('settings.connections')}</h2>
          <p className="muted small">{t('settings.connectionsHint')}</p>
          {settings.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              services={services}
              connection={connection}
              onChange={(patch) => updateConnection(connection.id, patch)}
              onRemove={() => removeConnection(connection.id)}
            />
          ))}
          <button type="button" className="wide" onClick={addConnection}><Plus size={18} /> {t('settings.addConnection')}</button>
        </section>

        <section>
          <h2>{t('settings.language')}</h2>
          <select value={settings.language} onChange={(event) => onChange({ ...settings, language: event.target.value })}>
            <option value="">{t('settings.languageSystem')}</option>
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
          </select>
        </section>

        <section>
          <h2>{t('settings.device')}</h2>
          <input
            value={settings.device.name}
            onChange={(event) => onChange({ ...settings, device: { ...settings.device, name: event.target.value } })}
          />
          <p className="muted small">{t('settings.deviceHint')}</p>
        </section>

        <section>
          <h2>{t('settings.account')}</h2>
          {email && <p>{email}</p>}
          <button type="button" className="danger wide" onClick={onSignOut}>{t('settings.signOut')}</button>
        </section>
      </main>
    </div>
  );
}

function ConnectionCard({ services, connection, onChange, onRemove }) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const preset = PROVIDER_PRESETS[connection.provider] || PROVIDER_PRESETS.custom;
  const models = connection.models || [];

  useEffect(() => {
    getApiKey(services.plugin, connection.id).then((value) => setHasKey(Boolean(value))).catch(() => {});
  }, [services, connection.id]);

  const saveKey = async () => {
    if (!key) return;
    await setApiKey(services.plugin, connection.id, key);
    setKey('');
    setHasKey(true);
  };

  const addModel = () => {
    const name = newModel.trim();
    if (name && !models.includes(name)) onChange({ models: [...models, name] });
    setNewModel('');
  };

  const loadModels = async () => {
    setLoading(true);
    setMessage('');
    try {
      await saveKey();
      const apiKey = await getApiKey(services.plugin, connection.id);
      const listed = await listProviderModels({ connection, apiKey, transport: services.transport });
      onChange({ models: [...new Set([...models, ...listed])] });
      setMessage(t('settings.loaded', { count: listed.length }));
    } catch (error) {
      setMessage(t('settings.loadFailed', { message: error?.message || String(error) }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <label className="field grow">
          <span>{t('settings.provider')}</span>
          <select value={connection.provider} onChange={(event) => onChange({ provider: event.target.value })}>
            {Object.keys(PROVIDER_PRESETS).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="icon" onClick={onRemove} aria-label={t('app.delete')}><Trash2 size={18} /></button>
      </div>
      <label className="field">
        <span>{t('settings.name')}</span>
        <input value={connection.name || ''} onChange={(event) => onChange({ name: event.target.value })} placeholder={connection.provider} />
      </label>
      <label className="field">
        <span>{t('settings.apiKey')}</span>
        <input type="password" value={key} onChange={(event) => setKey(event.target.value)} onBlur={saveKey} autoComplete="off" />
        {hasKey && <span className="muted small">{t('settings.apiKeySaved')}</span>}
      </label>
      <label className="field">
        <span>{t('settings.baseUrl')}</span>
        <input
          value={connection.baseUrl}
          onChange={(event) => onChange({ baseUrl: event.target.value })}
          placeholder={preset.baseUrl}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <span className="muted small">{t('settings.baseUrlHint')}</span>
      </label>
      <div className="field">
        <span>{t('settings.models')}</span>
        {models.length === 0 && <span className="muted small">{t('settings.modelsEmpty')}</span>}
        <div className="chips">
          {models.map((model) => (
            <span key={model} className="model-tag">
              <span className="ellipsis">{model}</span>
              <button
                type="button"
                className="icon tiny"
                onClick={() => onChange({ models: models.filter((other) => other !== model) })}
                aria-label={t('app.delete')}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <div className="inline-add">
          <input
            value={newModel}
            onChange={(event) => setNewModel(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addModel(); }}
            placeholder={t('settings.modelPlaceholder')}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button type="button" onClick={addModel} disabled={!newModel.trim()}><Plus size={18} /> {t('settings.addModel')}</button>
        </div>
        <button type="button" className="wide" onClick={loadModels} disabled={loading}>
          <Download size={18} /> {loading ? t('settings.loadingModels') : t('settings.loadModels')}
        </button>
        {message && <span className="muted small">{message}</span>}
      </div>
    </div>
  );
}
