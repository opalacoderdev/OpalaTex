import React, { useState } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { useModelValidation } from './useModelValidation';

// Modal for registering a new project.
export default function NewProjectModal({
  onClose,
  onSubmit,
  newProjName, setNewProjName,
  newProjPath, setNewProjPath,
  newProjDesc, setNewProjDesc,
  newProjModel, setNewProjModel,
  newProjWorkerModel, setNewProjWorkerModel,
  newProjMode, setNewProjMode,
  newProjApiKey, setNewProjApiKey,
  newProjApiBase, setNewProjApiBase,
  newProjWorkerApiKey, setNewProjWorkerApiKey,
  newProjWorkerApiBase, setNewProjWorkerApiBase,
  newProjModelParams, setNewProjModelParams,
  newProjWorkerModelParams, setNewProjWorkerModelParams,
  newProjError,
  modelConfigMsg,
  onLoadModelConfig,
  onOpenDirPicker,
}) {
  const { t } = useTranslation();
  const { hardware, modelStatus } = useModelValidation(newProjModel);
  const { hardware: workerHardware, modelStatus: workerModelStatus } = useModelValidation(newProjWorkerModel);

  const [activeTab, setActiveTab] = useState('geral');
  const isWindows = navigator.userAgent.toLowerCase().includes('windows');
  const dynamicPathHint = isWindows ? 'Ex: C:\\Projetos' : 'Ex: /home/user/projetos';

  const getBorderColor = (status) => {
    if (status === 'green') return '#4ade80';
    if (status === 'yellow') return '#facc15';
    if (status === 'red') return '#f87171';
    return undefined;
  };

  const handleParamChange = (setter, key, val) => {
    setter(prev => ({ ...prev, [key]: val }));
  };

  const tabs = [
    { id: 'geral', label: 'Geral' },
    { id: 'orquestrador', label: 'Orquestrador' },
    { id: 'worker', label: 'Worker' }
  ];

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal">
        <div className="vscode-sidebar-header" style={{ padding: '10px 16px', borderBottom: 'none' }}>
          <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)' }}>{t('newProjectModal.title')}</span>
          <button type="button" onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0' }}>
            <X size={14} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-border)', marginBottom: '16px', padding: '0 16px' }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: 'none',
                border: 'none',
                padding: '8px 16px',
                color: activeTab === tab.id ? 'var(--vscode-text-fg)' : '#808080',
                borderBottom: activeTab === tab.id ? '2px solid #007acc' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: activeTab === tab.id ? 'bold' : 'normal'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex flex-col overflow-y-auto flex-1" style={{ padding: '0 16px 16px 16px', gap: '12px' }}>
          
          {/* GERAL TAB */}
          {activeTab === 'geral' && (
            <>
              {/* Project name */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.projectName')}</label>
                <input
                  type="text"
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  placeholder={t('newProjectModal.projectNamePlaceholder')}
                  required
                />
              </div>

              {/* Project path */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.projectPath')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={newProjPath}
                    onChange={(e) => setNewProjPath(e.target.value)}
                    placeholder={dynamicPathHint}
                    required
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDirPicker('new', newProjPath || '~')}>
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              {/* Description */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.description')}</label>
                <textarea
                  value={newProjDesc}
                  onChange={(e) => setNewProjDesc(e.target.value)}
                  placeholder={t('newProjectModal.descriptionPlaceholder')}
                  rows={2}
                  style={{ resize: 'none' }}
                />
              </div>

              {/* Execution mode */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.executionMode')}</label>
                <select value={newProjMode} onChange={(e) => setNewProjMode(e.target.value)}>
                  <option value="auto">{t('newProjectModal.modeAuto')}</option>
                  <option value="plan">{t('newProjectModal.modePlan')}</option>
                  <option value="edit">{t('newProjectModal.modeEdit')}</option>
                </select>
              </div>
              {/* Internal Monologue / Tool Role Workaround */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <input
                  id="internal-monologue-new"
                  type="checkbox"
                  checked={(newProjModelParams?.tool_role_workaround ?? 'user') !== ''}
                  onChange={e => {
                    const checked = e.target.checked;
                    const val = checked ? 'user' : ''; 
                    setNewProjModelParams(p => ({ ...p, tool_role_workaround: val }));
                    setNewProjWorkerModelParams(p => ({ ...p, tool_role_workaround: val }));
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="internal-monologue-new"
                       style={{ fontSize: '12px', color: 'var(--vscode-text-fg)', cursor: 'pointer', userSelect: 'none' }}>
                  Habilitar Internal Monologue (Ollama Tool Fix)
                </label>
              </div>

              {/* Monologue as Assistant */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', marginLeft: '24px' }}>
                <input
                  id="monologue-as-assistant-new"
                  type="checkbox"
                  checked={newProjModelParams?.tool_role_workaround === 'assistant'}
                  disabled={(newProjModelParams?.tool_role_workaround ?? 'user') === ''}
                  onChange={e => {
                    const checked = e.target.checked;
                    const val = checked ? 'assistant' : 'user';
                    setNewProjModelParams(p => ({ ...p, tool_role_workaround: val }));
                    setNewProjWorkerModelParams(p => ({ ...p, tool_role_workaround: val }));
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="monologue-as-assistant-new"
                       style={{ fontSize: '12px', color: 'var(--vscode-text-fg)', cursor: 'pointer', userSelect: 'none', opacity: (newProjModelParams?.tool_role_workaround ?? 'user') !== '' ? 1 : 0.5 }}>
                  Monologue as Assistant (usar "assistant" em vez de "user")
                </label>
              </div>
            </>
          )}

          {/* ORQUESTRADOR TAB */}
          {activeTab === 'orquestrador' && (
            <>
              {/* Load refined config */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <button type="button" className="vscode-button" style={{ background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)', fontSize: '12px' }} onClick={onLoadModelConfig}>
                  {t('newProjectModal.loadRefinedConfig')}
                </button>
                {modelConfigMsg && (
                  <span style={{ fontSize: '11px', color: modelConfigMsg.startsWith('✅') ? '#4ec9b0' : '#f48771' }}>
                    {modelConfigMsg}
                  </span>
                )}
              </div>

              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.aiModel')}</label>
                <input
                  type="text"
                  list="default-models"
                  value={newProjModel}
                  onChange={(e) => setNewProjModel(e.target.value)}
                  onBlur={() => onLoadModelConfig(true)}
                  placeholder={t('newProjectModal.modelPlaceholder')}
                  style={{ borderColor: getBorderColor(modelStatus), borderWidth: modelStatus !== 'unknown' ? '2px' : '1px' }}
                />
                <datalist id="default-models">
                  <option value="gemini/gemini-flash-lite-latest" />
                  <option value="anthropic/claude-3-5-sonnet-latest" />
                  <option value="openai/gpt-4o" />
                  <option value="ollama/gemma4:12b" />
                  <option value="ollama/gemma4:31b-cloud" />
                </datalist>
                {modelStatus === 'green' && <span style={{ fontSize: '10px', color: '#4ade80' }}>✓ Modelo adequado.</span>}
                {modelStatus === 'yellow' && <span style={{ fontSize: '10px', color: '#facc15' }}>⚠ Poderá ficar lento.</span>}
                {modelStatus === 'red' && <span style={{ fontSize: '10px', color: '#f87171' }}>❌ Pode exceder VRAM.</span>}
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.apiKey')}</label>
                  <input type="password" value={newProjApiKey} onChange={(e) => setNewProjApiKey(e.target.value)} placeholder={t('newProjectModal.apiKeyPlaceholder')} />
                </div>
                <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.apiBase')}</label>
                  <input type="text" value={newProjApiBase} onChange={(e) => setNewProjApiBase(e.target.value)} placeholder={t('newProjectModal.apiBasePlaceholder')} />
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#808080', marginTop: '-6px', lineHeight: '1.4' }}>
                <Trans i18nKey="newProjectModal.ollamaTip" components={[<span />, <strong />]} />
              </div>

              {/* Advanced params for Orchestrator */}
              <details style={{ background: 'var(--vscode-input-bg)', padding: '8px', borderRadius: '4px', border: '1px solid var(--vscode-border)' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--vscode-text-fg)', fontWeight: 'bold' }}>Parâmetros Avançados (Orquestrador)</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>Temperature</label>
                      <input type="number" step="0.1" value={newProjModelParams?.temperature ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 0.7" />
                    </div>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>Max Tokens</label>
                      <input type="number" value={newProjModelParams?.max_tokens ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'max_tokens', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 4096" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>Max Heartbeats (MemGPT)</label>
                        <input type="number" value={newProjModelParams?.max_heartbeats ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'max_heartbeats', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 10" />
                     </div>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>Loop Detection Limit</label>
                        <input type="number" value={newProjModelParams?.loop_detection_limit ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'loop_detection_limit', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 3" />
                     </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                        <input type="checkbox"
                           checked={newProjModelParams?.loop_detection ?? true}
                           onChange={e => handleParamChange(setNewProjModelParams, 'loop_detection', e.target.checked)} />
                        <span style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>Enable Loop Detection</span>
                     </label>
                  </div>
                </div>
              </details>
            </>
          )}

          {/* WORKER TAB */}
          {activeTab === 'worker' && (
            <>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>Worker Model</label>
                <input
                  type="text"
                  list="default-worker-models"
                  value={newProjWorkerModel}
                  onChange={e => setNewProjWorkerModel(e.target.value)}
                  placeholder="ollama/gemma4:12b (Opcional)"
                  style={{ borderColor: getBorderColor(workerModelStatus), borderWidth: workerModelStatus !== 'unknown' ? '2px' : '1px' }}
                />
                <datalist id="default-worker-models">
                  <option value="gemini/gemini-flash-lite-latest" />
                  <option value="anthropic/claude-3-5-sonnet-latest" />
                  <option value="ollama/gemma4:12b" />
                  <option value="ollama/gemma4:31b-cloud" />
                </datalist>
                {workerModelStatus === 'green' && <span style={{ fontSize: '10px', color: '#4ade80' }}>✓ Modelo adequado.</span>}
                {workerModelStatus === 'yellow' && <span style={{ fontSize: '10px', color: '#facc15' }}>⚠ Poderá ficar lento.</span>}
                {workerModelStatus === 'red' && <span style={{ fontSize: '10px', color: '#f87171' }}>❌ Pode exceder VRAM.</span>}
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>Worker API Key</label>
                  <input type="password" value={newProjWorkerApiKey} onChange={e => setNewProjWorkerApiKey(e.target.value)} placeholder="API Key for Worker" />
                </div>
                <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>Worker API Base</label>
                  <input type="text" value={newProjWorkerApiBase} onChange={e => setNewProjWorkerApiBase(e.target.value)} placeholder="http://localhost:11434/v1" />
                </div>
              </div>

              {/* Advanced params for Worker */}
              <details style={{ background: 'var(--vscode-input-bg)', padding: '8px', borderRadius: '4px', border: '1px solid var(--vscode-border)' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--vscode-text-fg)', fontWeight: 'bold' }}>Parâmetros Avançados (Worker)</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#ccc' }}>Temperature</label>
                      <input type="number" step="0.1" value={newProjWorkerModelParams?.temperature ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 0.2" />
                    </div>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#ccc' }}>Max Tokens</label>
                      <input type="number" value={newProjWorkerModelParams?.max_tokens ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'max_tokens', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 8192" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#ccc' }}>Max Iterations</label>
                        <input type="number" value={newProjWorkerModelParams?.max_iterations ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'max_iterations', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 40" />
                     </div>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#ccc' }}>Loop Detection Limit</label>
                        <input type="number" value={newProjWorkerModelParams?.loop_detection_limit ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'loop_detection_limit', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 3" />
                     </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                        <input type="checkbox"
                           checked={newProjWorkerModelParams?.loop_detection ?? true}
                           onChange={e => handleParamChange(setNewProjWorkerModelParams, 'loop_detection', e.target.checked)} />
                        <span style={{ fontSize: '11px', color: '#ccc' }}>Enable Loop Detection</span>
                     </label>
                  </div>
                </div>
              </details>
            </>
          )}

          {newProjError && (
            <div style={{ color: '#f48771', fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
              ⚠️ {newProjError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '12px', borderTop: '1px solid var(--vscode-border)', marginTop: '4px' }}>
            <button type="button" onClick={onClose} className="vscode-button" style={{ background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('newProjectModal.cancel')}
            </button>
            <button type="submit" className="vscode-button">{t('newProjectModal.register')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
