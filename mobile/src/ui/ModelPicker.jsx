import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Settings as SettingsIcon } from 'lucide-react';
import { resolveModel } from '../agent/providers.js';

export function connectionLabel(connection) {
  return connection?.name || connection?.provider || '';
}

/**
 * Pick the model a chat runs on: any model of any configured connection, or
 * the model the desktop project names when a connection can serve it.
 */
export default function ModelPicker({ connections, desktopModelId, current, onPick, onClose, onOpenSettings }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const desktop = desktopModelId ? resolveModel(desktopModelId, connections) : null;
  const total = connections.reduce((sum, connection) => sum + (connection.models || []).length, 0);
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => connections.map((connection) => ({
    connection,
    models: (connection.models || []).filter((model) => !needle || model.toLowerCase().includes(needle)),
  })), [connections, needle]);

  const isCurrent = (connectionId, model) => current?.connectionId === connectionId && current?.model === model;

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('picker.title')} onClick={onClose}>
      <div className="sheet picker" onClick={(event) => event.stopPropagation()}>
        <h2>{t('picker.title')}</h2>
        {connections.length === 0 ? (
          <>
            <p className="muted">{t('picker.empty')}</p>
            <button type="button" className="primary wide" onClick={onOpenSettings}><Plus size={18} /> {t('picker.addConnection')}</button>
          </>
        ) : (
          <>
            {desktop?.ok && (
              <button
                type="button"
                className="row picker-row"
                onClick={() => onPick({ connectionId: desktop.connection.id, model: desktop.model })}
              >
                <span className="row-main">
                  <span className="row-title">{desktop.model}</span>
                  <span className="row-sub">{t('picker.desktop')} · {connectionLabel(desktop.connection)}</span>
                </span>
                {isCurrent(desktop.connection.id, desktop.model) && <Check size={18} />}
              </button>
            )}
            {total > 8 && (
              <input
                className="picker-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('picker.search')}
                autoCapitalize="off"
                autoCorrect="off"
              />
            )}
            {groups.map(({ connection, models }) => (
              <section key={connection.id} className="picker-group">
                <h3>{connectionLabel(connection)}</h3>
                {(connection.models || []).length === 0 && <p className="muted small">{t('picker.noModels')}</p>}
                {models.map((model) => (
                  <button key={model} type="button" className="row picker-row" onClick={() => onPick({ connectionId: connection.id, model })}>
                    <span className="row-main"><span className="row-title">{model}</span></span>
                    {isCurrent(connection.id, model) && <Check size={18} />}
                  </button>
                ))}
              </section>
            ))}
            <button type="button" className="wide" onClick={onOpenSettings}><SettingsIcon size={18} /> {t('picker.manage')}</button>
          </>
        )}
      </div>
    </div>
  );
}
