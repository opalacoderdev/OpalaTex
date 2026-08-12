import React, { useState, useEffect } from 'react';
import { Cpu, RefreshCw, Settings2, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const modelOptionLabel = (model, models) => {
  const name = model.name || model.id;
  const matchingModels = models.filter(candidate => (candidate.name || candidate.id) === name);
  if (matchingModels.length < 2) return name;

  return `${name} #${matchingModels.findIndex(candidate => candidate.id === model.id) + 1}`;
};
export default function TopBar({
  activeProject,
  globalModels,
  onRefreshModels,
  onEditModels,
  onModelChange,
}) {
  const { t } = useTranslation();

  // Handle Orchestrator Model change
  const handleOrchestratorChange = (e) => {
    const val = e.target.value;
    if (val === 'edit_models') {
      onEditModels();
      return;
    }
    if (val === 'refresh_models') {
      onRefreshModels();
      return;
    }
    onModelChange('model', val);
  };

  // Handle Worker Model change
  const handleWorkerChange = (e) => {
    const val = e.target.value;
    if (val === 'edit_models') {
      onEditModels();
      return;
    }
    if (val === 'refresh_models') {
      onRefreshModels();
      return;
    }
    onModelChange('worker_model', val);
  };

  // Group models by provider
  const groupedModels = globalModels.reduce((acc, model) => {
    const provider = model.provider || 'custom';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {});

  const renderOptions = () => {
    return (
      <>
        {Object.entries(groupedModels).map(([provider, models]) => (
          <optgroup key={provider} label={provider.toUpperCase()}>
            {models.map(m => (
              <option key={m.id} value={m.id} title={m.api_base ? `${t('topBar.apiBaseUrl', 'API Base URL')}: ${m.api_base}` : undefined}>
                {modelOptionLabel(m, models)}
              </option>
            ))}
          </optgroup>
        ))}
        <optgroup label={t('topBar.actionsGroup')}>
          <option value="refresh_models">{t('topBar.refreshModels')}</option>
          <option value="edit_models">{t('topBar.editModels')}</option>
        </optgroup>
      </>
    );
  };

  const projectModel = activeProject?.model || '';
  const projectWorkerModel = activeProject?.worker_model || '';

  // Find api_base of the currently selected models for tooltip hint
  const selectedOrchestratorModel = globalModels.find(m => m.id === projectModel);
  const selectedWorkerModel = globalModels.find(m => m.id === projectWorkerModel);
  const orchestratorTitle = selectedOrchestratorModel?.api_base
    ? `${t('topBar.apiBaseUrl', 'API Base URL')}: ${selectedOrchestratorModel.api_base}`
    : undefined;
  const workerTitle = selectedWorkerModel?.api_base
    ? `${t('topBar.apiBaseUrl', 'API Base URL')}: ${selectedWorkerModel.api_base}`
    : undefined;

  return (
    <div className="vscode-topbar" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '4px 16px',
      background: 'var(--vscode-titleBar-activeBackground, #1e1e1e)',
      borderBottom: '1px solid var(--vscode-widget-border, #3c3c3c)',
      minHeight: '35px',
      userSelect: 'none'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* App Title / Logo Area could go here */}
        <span style={{ fontWeight: 'bold', color: 'var(--vscode-titleBar-activeForeground, #cccccc)', fontSize: '13px' }}>
          OpalaTex
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {/* Orchestrator Model Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Settings2 size={14} style={{ color: 'var(--vscode-descriptionForeground, #888888)' }} title={t('topBar.orchestratorModel')} />
          <span style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground, #888888)' }}>{t('topBar.orchestrator')}:</span>
          <select
            className="vscode-settings-input"
            style={{ width: '180px', padding: '2px 4px', fontSize: '12px', height: '24px' }}
            value={projectModel}
            onChange={handleOrchestratorChange}
            disabled={!activeProject}
            title={orchestratorTitle}
          >
            {!projectModel && <option value="">{t('topBar.selectModel')}</option>}
            {renderOptions()}
          </select>
        </div>

        {/* Worker Model Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Cpu size={14} style={{ color: 'var(--vscode-descriptionForeground, #888888)' }} title={t('topBar.workerModel')} />
          <span style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground, #888888)' }}>{t('topBar.worker')}:</span>
          <select
            className="vscode-settings-input"
            style={{ width: '180px', padding: '2px 4px', fontSize: '12px', height: '24px' }}
            value={projectWorkerModel}
            onChange={handleWorkerChange}
            disabled={!activeProject}
            title={workerTitle}
          >
            {!projectWorkerModel && <option value="">{t('topBar.selectWorker')}</option>}
            {renderOptions()}
          </select>
        </div>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', width: '60px' }}>
         {/* Placeholder for right side alignment */}
      </div>
    </div>
  );
}
