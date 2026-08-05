import React, { useState } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModelValidation } from './useModelValidation';
import { FEATURES } from '../../config/features';

// Modal for registering a new project.
export default function NewProjectModal({
  globalAiProvider,
  globalCloudModel = 'OpalaTexCloud',
  globalModels = [],
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
  onOpenDirPicker,
}) {
  const { t } = useTranslation();
  const { hardware, modelStatus } = useModelValidation(newProjModel, newProjApiBase);
  const { hardware: workerHardware, modelStatus: workerModelStatus } = useModelValidation(newProjWorkerModel, newProjWorkerApiBase || newProjApiBase);

  const [activeTab, setActiveTab] = useState('geral');

  const isWindows = navigator.userAgent.toLowerCase().includes('windows');
  const dynamicPathHint = isWindows ? t('newProjectModal.pathHintWindows', 'Ex: C:\\\\Projects') : t('newProjectModal.pathHintUnix', 'Ex: /home/user/projects');

  const getBorderColor = (status) => {
    if (status === 'green') return '#4ade80';
    if (status === 'yellow') return '#facc15';
    if (status === 'red') return '#f87171';
    return undefined;
  };

  const handleParamChange = (setter, key, val) => {
    setter(prev => ({ ...prev, [key]: val }));
  };

  const setProjectModel = (value, target) => {
    if (target === 'worker') {
      setNewProjWorkerModel(value);
      return;
    }

    setNewProjModel(value);
  };

  const tabs = [
    { id: 'geral', label: t('editProjectModal.tabGeneral') },
    { id: 'orquestrador', label: t('editProjectModal.tabOrchestrator') },
    { id: 'worker', label: t('editProjectModal.tabWorker') }
  ];

  const cloudNoticeStyle = {
    padding: '8px',
    background: 'rgba(0, 122, 204, 0.1)',
    border: '1px solid #007acc',
    borderRadius: '4px',
    fontSize: '12px',
    color: '#007acc',
    marginTop: '4px'
  };

  const cloudModelOptions = [
    { value: 'OpalaTexCloud', label: t('editProjectModal.opalaCloudLiteOption', 'OpalaTex Live (standard credit use)') },
    { value: 'OpalaTexCloudGemini35Flash', label: t('editProjectModal.opalaCloudFlashOption', 'OpalaTex Flash (4x credit use)') }
  ];
  const normalizeCloudModel = (value) => {
    if (cloudModelOptions.some(option => option.value === value)) return value;
    if (cloudModelOptions.some(option => option.value === globalCloudModel)) return globalCloudModel;
    return 'OpalaTexCloud';
  };

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
            </>
          )}

          {/* ORQUESTRADOR TAB */}
          {activeTab === 'orquestrador' && (
            <>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.aiModel')}</label>
                {FEATURES.enableCloudModels && globalAiProvider === 'cloud' ? (
                  <>
                    <select
                      className="vscode-settings-input"
                      value={normalizeCloudModel(newProjModel)}
                      onChange={(e) => setProjectModel(e.target.value, 'main')}
                    >
                      {cloudModelOptions.map(option => (
                        <option key={`new-cloud-main-${option.value}`} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <div style={cloudNoticeStyle}>
                      <strong>{t('editProjectModal.opalaCloudEnabled')}</strong><br />
                      {t('editProjectModal.cloudOrchestratorNotice')}<br />
                      <em>{t('editProjectModal.cloudAdvancedNotice')}</em><br />
                      <strong>{t('editProjectModal.cloudFlashCostNotice', 'Gemini 3.5 Flash consumes credits 6x faster than Lite.')}</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      list="default-models"
                      value={newProjModel}
                      onChange={(e) => setProjectModel(e.target.value, 'main')}
                      placeholder={t('newProjectModal.modelPlaceholder')}
                      style={{ borderColor: getBorderColor(modelStatus), borderWidth: modelStatus !== 'unknown' ? '2px' : '1px' }}
                    />
                    <datalist id="default-models">
                      {FEATURES.enableCloudModels && <option value="OpalaTexCloud" />}
                      {(globalModels || []).map(m => (
                        <option key={`new-model-${m.id}`} value={m.id} />
                      ))}
                      <option value="gemini/gemini-flash-lite-latest" />
                      <option value="anthropic/claude-3-5-sonnet-latest" />
                      <option value="openai/gpt-4o-mini" />
                      <option value="openai/gpt-4o" />
                      <option value="ollama/gemma4:12b" />
                      <option value="ollama/gemma4:31b-cloud" />
                    </datalist>
                  </>
                )}
                {(globalAiProvider !== 'cloud' || !FEATURES.enableCloudModels) && (
                  <>
                    {modelStatus === 'green' && <span style={{ fontSize: '10px', color: '#4ade80' }}>{t('editProjectModal.modelSuitable')}</span>}
                    {modelStatus === 'yellow' && <span style={{ fontSize: '10px', color: '#facc15' }}>{t('editProjectModal.modelMayBeSlow')}</span>}
                    {modelStatus === 'red' && <span style={{ fontSize: '10px', color: '#f87171' }}>{t('editProjectModal.modelMayExceedVram')}</span>}
                  </>
                )}
              </div>

              {/* Advanced params for Orchestrator */}
              <details style={{ background: 'var(--vscode-input-bg)', padding: '8px', borderRadius: '4px', border: '1px solid var(--vscode-border)' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--vscode-text-fg)', fontWeight: 'bold' }}>{t('editProjectModal.advancedOrchestrator')}</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.temperature')}</label>
                      <input type="number" step="0.1" value={newProjModelParams?.temperature ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 0.7" />
                    </div>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.maxTokens')}</label>
                      <input type="number" value={newProjModelParams?.max_tokens ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'max_tokens', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 4096" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.maxHeartbeats')}</label>
                        <input type="number" value={newProjModelParams?.max_heartbeats ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'max_heartbeats', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 10" />
                     </div>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.loopDetectionLimit')}</label>
                        <input type="number" value={newProjModelParams?.loop_detection_limit ?? ''} onChange={e => handleParamChange(setNewProjModelParams, 'loop_detection_limit', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 3" />
                     </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                        <input type="checkbox"
                           checked={newProjModelParams?.loop_detection ?? true}
                           onChange={e => handleParamChange(setNewProjModelParams, 'loop_detection', e.target.checked)} />
                         <span style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.enableLoopDetection')}</span>
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
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.workerModel')}</label>
                {FEATURES.enableCloudModels && globalAiProvider === 'cloud' ? (
                  <>
                    <select
                      className="vscode-settings-input"
                      value={normalizeCloudModel(newProjWorkerModel)}
                      onChange={e => setProjectModel(e.target.value, 'worker')}
                    >
                      {cloudModelOptions.map(option => (
                        <option key={`new-cloud-worker-${option.value}`} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <div style={cloudNoticeStyle}>
                      <strong>{t('editProjectModal.opalaCloudEnabled')}</strong><br />
                      {t('editProjectModal.cloudWorkerNotice')}<br />
                      <strong>{t('editProjectModal.cloudFlashCostNotice', 'Gemini 3.5 Flash consumes credits 6x faster than Lite.')}</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      list="default-worker-models"
                      value={newProjWorkerModel}
                      onChange={e => setProjectModel(e.target.value, 'worker')}
                      placeholder={t('newProjectModal.workerModelPlaceholder')}
                      style={{ borderColor: getBorderColor(workerModelStatus), borderWidth: workerModelStatus !== 'unknown' ? '2px' : '1px' }}
                    />
                    <datalist id="default-worker-models">
                      {FEATURES.enableCloudModels && <option value="OpalaTexCloud" />}
                      {(globalModels || []).map(m => (
                        <option key={`new-worker-model-${m.id}`} value={m.id} />
                      ))}
                      <option value="gemini/gemini-flash-lite-latest" />
                      <option value="anthropic/claude-3-5-sonnet-latest" />
                      <option value="openai/gpt-4o-mini" />
                      <option value="openai/gpt-4o" />
                      <option value="ollama/gemma4:12b" />
                      <option value="ollama/gemma4:31b-cloud" />
                    </datalist>
                  </>
                )}
                {(globalAiProvider !== 'cloud' || !FEATURES.enableCloudModels) && (
                  <>
                    {workerModelStatus === 'green' && <span style={{ fontSize: '10px', color: '#4ade80' }}>{t('editProjectModal.modelSuitable')}</span>}
                    {workerModelStatus === 'yellow' && <span style={{ fontSize: '10px', color: '#facc15' }}>{t('editProjectModal.modelMayBeSlow')}</span>}
                    {workerModelStatus === 'red' && <span style={{ fontSize: '10px', color: '#f87171' }}>{t('editProjectModal.modelMayExceedVram')}</span>}
                  </>
                )}
              </div>

              {/* Advanced params for Worker */}
              <details style={{ background: 'var(--vscode-input-bg)', padding: '8px', borderRadius: '4px', border: '1px solid var(--vscode-border)' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--vscode-text-fg)', fontWeight: 'bold' }}>{t('editProjectModal.advancedWorker')}</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#ccc' }}>{t('editProjectModal.temperature')}</label>
                      <input type="number" step="0.1" value={newProjWorkerModelParams?.temperature ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 0.2" />
                    </div>
                    <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#ccc' }}>{t('editProjectModal.maxTokens')}</label>
                      <input type="number" value={newProjWorkerModelParams?.max_tokens ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'max_tokens', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 8192" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#ccc' }}>{t('editProjectModal.maxIterations')}</label>
                        <input type="number" value={newProjWorkerModelParams?.max_iterations ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'max_iterations', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 40" />
                     </div>
                     <div className="flex flex-col flex-1" style={{ gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#ccc' }}>{t('editProjectModal.loopDetectionLimit')}</label>
                        <input type="number" value={newProjWorkerModelParams?.loop_detection_limit ?? ''} onChange={e => handleParamChange(setNewProjWorkerModelParams, 'loop_detection_limit', e.target.value ? parseInt(e.target.value) : undefined)} className="vscode-settings-input" placeholder="Ex: 3" />
                     </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                        <input type="checkbox"
                           checked={newProjWorkerModelParams?.loop_detection ?? true}
                           onChange={e => handleParamChange(setNewProjWorkerModelParams, 'loop_detection', e.target.checked)} />
                        <span style={{ fontSize: '11px', color: '#ccc' }}>{t('editProjectModal.enableLoopDetection')}</span>
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
