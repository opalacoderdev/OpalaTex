import React, { useState } from 'react';
import { X, Settings, Check, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModelValidation } from './useModelValidation';
import { useCustomDialog } from './CustomDialogProvider';

// Numeric input helper to avoid repetition in the advanced params grid.
function ParamNumber({ label, value, onChange, step, min, max, placeholder }) {
  return (
    <div className="flex flex-col" style={{ gap: '4px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={onChange}
      />
    </div>
  );
}

// Project settings edit modal (model params, paths, credentials, etc.).
export default function EditProjectModal({
  globalModels = [],
  editingProject,
  setEditingProject,
  onClose,
  onSubmit,
  editProjError,
  showAdvancedParams,
  setShowAdvancedParams,
  onOpenDirPicker,
}) {
  const { t } = useTranslation();
  const { showAlert } = useCustomDialog();
  const { hardware, modelStatus } = useModelValidation(editingProject?.model, editingProject?.api_base);
  const { hardware: workerHardware, modelStatus: workerModelStatus } = useModelValidation(editingProject?.worker_model, editingProject?.worker_api_base || editingProject?.api_base);

  const [activeTab, setActiveTab] = useState('geral');

  const getBorderColor = (status) => {
    if (status === 'green') return '#4ade80';
    if (status === 'yellow') return '#facc15';
    if (status === 'red') return '#f87171';
    return undefined;
  };

  if (!editingProject) return null;

  // Helper to update a model_param key.
  const setParam = (key, value, isWorker = false) => {
    setEditingProject(p => {
      if (!p) return p;
      const targetObj = isWorker ? p.worker_model_params : p.model_params;
      const n = { ...(targetObj || {}) };
      
      if (value === undefined || value === '') {
        delete n[key];
      } else {
        let clampedValue = value;
        const limits = {
          temperature: { min: 0, max: 2 },
          top_p: { min: 0, max: 1 },
          frequency_penalty: { min: -2, max: 2 },
          presence_penalty: { min: -2, max: 2 },
          min_p: { min: 0, max: 1 },
          eviction_threshold: { min: 0, max: 1 },
          memory_pressure_threshold: { min: 0, max: 1 },
          max_tokens: { min: 1 },
          num_ctx: { min: 1 },
          seed: { min: 0 },
          top_k: { min: 1 },
          repetition_penalty: { min: 0 },
          max_heartbeats: { min: 1 },
          max_context_tokens: { min: 1 },
          max_iterations: { min: 1 },
          max_tool_calls: { min: 1 },
        };
        if (limits[key] && typeof clampedValue === 'number') {
          const { min, max } = limits[key];
          if (min !== undefined && clampedValue < min) clampedValue = min;
          if (max !== undefined && clampedValue > max) clampedValue = max;
        }
        n[key] = clampedValue;
      }
      
      return isWorker ? { ...p, worker_model_params: n } : { ...p, model_params: n };
    });
  };

  const setProjectModel = (value, target) => {
    setEditingProject(p => {
      if (!p) return p;
      if (target === 'worker') {
        return { ...p, worker_model: value };
      }

      return { ...p, model: value };
    });
  };

  const parseNum = (str, asFloat = false) => {
    if (str === '' || str === undefined || str === null) return undefined;
    const cleanStr = String(str).replace(',', '.');
    const val = asFloat ? parseFloat(cleanStr) : parseInt(cleanStr, 10);
    return isNaN(val) ? undefined : val;
  };

  const tabs = [
    { id: 'geral', label: t('editProjectModal.tabGeneral') },
    { id: 'orquestrador', label: t('editProjectModal.tabOrchestrator') },
    { id: 'worker', label: t('editProjectModal.tabWorker') }
  ];
  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{ maxWidth: '520px', width: '92%' }}>
        {/* Header */}
        <div className="vscode-sidebar-header" style={{ padding: '10px 16px', borderBottom: 'none' }}>
          <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={14} style={{ color: '#007acc' }} />
            {t('editProjectModal.title', { name: editingProject.project_name || editingProject.name })}
          </span>
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

        <form onSubmit={onSubmit} className="flex flex-col overflow-y-auto flex-1" style={{ padding: '0 16px 16px 16px', gap: '14px' }}>

          {/* GERAL TAB */}
          {activeTab === 'geral' && (
            <>
              {/* Internal key (read-only) */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.internalId')}</label>
                <input type="text" value={editingProject.name} readOnly style={{ opacity: 0.5, cursor: 'not-allowed' }} />
              </div>

              {/* Display name */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.displayName')}</label>
                <input
                  type="text"
                  value={editingProject.project_name}
                  onChange={e => setEditingProject(p => ({ ...p, project_name: e.target.value }))}
                  required
                  placeholder={t('editProjectModal.projectNamePlaceholder')}
                />
              </div>

              {/* Project path */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.projectPath')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={editingProject.project_path}
                    onChange={e => setEditingProject(p => ({ ...p, project_path: e.target.value }))}
                    placeholder={t('editProjectModal.projectPathPlaceholder')}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDirPicker('edit', editingProject.project_path || '~')}>
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              {/* Main File */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.mainFile')}</label>
                <input
                  type="text"
                  className="vscode-settings-input"
                  value={editingProject.main_file || ''}
                  onChange={e => setEditingProject(p => ({ ...p, main_file: e.target.value }))}
                  placeholder={t('editProjectModal.mainFilePlaceholder')}
                  style={{ flex: 1 }}
                />
              </div>

              <div className="flex flex-col" style={{ gap: '8px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.latexCompileOnSave')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_partial !== true && editingProject.compile_on_save_full !== true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: false,
                      compile_on_save_full: false,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSaveDisabled')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_partial === true && editingProject.compile_on_save_full !== true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: true,
                      compile_on_save_full: false,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSavePartial')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_full === true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: false,
                      compile_on_save_full: true,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSaveFull')}</span>
                </label>
              </div>

              {/* User Git root */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.gitRoot')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    className="vscode-settings-input"
                    value={editingProject.git_root_path || ''}
                    onChange={e => setEditingProject(p => ({ ...p, git_root_path: e.target.value }))}
                    placeholder={t('editProjectModal.gitRootPlaceholder')}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDirPicker('edit-git-root', editingProject.git_root_path || editingProject.project_path || '~')}>
                    <FolderOpen size={14} />
                  </button>
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => setEditingProject(p => ({ ...p, git_root_path: '' }))}>
                    {t('editProjectModal.clear')}
                  </button>
                </div>
              </div>

              {/* Mode */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.mode')}</label>
                <select className="vscode-settings-input" value={editingProject.mode} onChange={e => setEditingProject(p => ({ ...p, mode: e.target.value }))}>
                  <option value="auto">{t('editProjectModal.modeAuto')}</option>
                  <option value="plan">{t('editProjectModal.modePlan')}</option>
                  <option value="edit">{t('editProjectModal.modeEdit')}</option>
                </select>
              </div>

              {/* Description */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.description')}</label>
                <textarea
                  value={editingProject.description}
                  onChange={e => setEditingProject(p => ({ ...p, description: e.target.value }))}
                  placeholder={t('editProjectModal.descriptionPlaceholder')}
                  rows={2}
                  style={{ resize: 'none' }}
                />
              </div>
              
              {/* Shared Memory Checkbox */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <input
                  id="use-shared-memory-edit"
                  type="checkbox"
                  checked={editingProject.use_shared_memory ?? false}
                  onChange={e => setEditingProject(p => ({ ...p, use_shared_memory: e.target.checked }))}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="use-shared-memory-edit" style={{ fontSize: '12px', color: 'var(--vscode-text-fg)', cursor: 'pointer', userSelect: 'none' }}>
                  {t('editProjectModal.shareCoreMemory')}
                </label>
              </div>

              {/* Force Vision — applies uniformly to both Orchestrator and Worker models */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <input
                  id="force-vision-edit"
                  type="checkbox"
                  checked={!!editingProject.model_params?.force_vision}
                  onChange={e => {
                    const v = e.target.checked;
                    setEditingProject(p => ({
                      ...p,
                      model_params: { ...p.model_params, force_vision: v },
                      worker_model_params: { ...p.worker_model_params, force_vision: v },
                    }));
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="force-vision-edit"
                       style={{ fontSize: '12px', color: 'var(--vscode-text-fg)', cursor: 'pointer', userSelect: 'none' }}
                       title={t('editProjectModal.forceVisionTitle')}>
                  {t('editProjectModal.forceVision')}
                </label>
              </div>

              {/* Contextual Skills Loader */}
              <div style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  className="vscode-button"
                  style={{ width: '100%', padding: '8px', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)' }}
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/opalatex/load-contextual-skills', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ project_path: editingProject.project_path })
                      });
                      if (res.ok) {
                        await showAlert(t('settingsModal.contextualSkillsLoaded'));
                      } else {
                        await showAlert(t('editProjectModal.contextualSkillsLoadError'));
                      }
                    } catch (e) {
                      await showAlert(String(e));
                    }
                  }}
                >
                  {t('settingsModal.loadContextualSkills')}
                </button>
              </div>

            </>
          )}

          {/* ORQUESTRADOR TAB */}
          {activeTab === 'orquestrador' && (
            <>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.mainModel')}</label>
                <input
                  type="text"
                  list="edit-models"
                  value={editingProject.model}
                  onChange={e => setProjectModel(e.target.value, 'main')}
                  placeholder="gemini/gemini-2.5-flash"
                  style={{ borderColor: getBorderColor(modelStatus), borderWidth: modelStatus !== 'unknown' ? '2px' : '1px' }}
                />
                {/* Suggestions come only from the global model store, so the field never
                    offers a model the project cannot actually resolve. */}
                <datalist id="edit-models">
                  {(globalModels || []).map(m => (
                    <option key={`edit-model-${m.id}`} value={m.id} />
                  ))}
                </datalist>
                {modelStatus === 'green' && <span style={{ fontSize: '10px', color: '#4ade80' }}>{t('editProjectModal.modelSuitable')}</span>}
                {modelStatus === 'yellow' && <span style={{ fontSize: '10px', color: '#facc15' }}>{t('editProjectModal.modelMayBeSlow')}</span>}
                {modelStatus === 'red' && <span style={{ fontSize: '10px', color: '#f87171' }}>{t('editProjectModal.modelMayExceedVram')}</span>}
              </div>

              {/* Advanced params (collapsible) */}
              <div className="flex flex-col" style={{ marginTop: '4px' }}>
                <button
                  type="button"
                  onClick={() => setShowAdvancedParams(!showAdvancedParams)}
                  style={{ background: 'transparent', border: 'none', color: '#007acc', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 0', fontSize: '12px', fontWeight: 'bold', textAlign: 'left', width: 'fit-content' }}
                >
                  <span>{showAdvancedParams ? '▼' : '▶'} {t('editProjectModal.advancedOrchestrator')}</span>
                </button>

                {showAdvancedParams && (
                  <div style={{ border: '1px solid var(--vscode-border)', borderRadius: '4px', padding: '12px', marginTop: '8px', backgroundColor: 'var(--vscode-input-bg)', display: 'flex', flexDirection: 'column', gap: '16px' }}>

                    {/* LiteLLM params */}
                    <div>
                      <div style={{ color: '#9cdcfe', fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {t('editProjectModal.litellmParams')}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <ParamNumber label={t('editProjectModal.temperature')} step="0.1" min="0" max="2" placeholder={t('editProjectModal.defaultTemperature')}
                          value={editingProject.model_params?.temperature}
                          onChange={e => setParam('temperature', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.maxTokens')} min="1" placeholder={t('editProjectModal.unlimited')}
                          value={editingProject.model_params?.max_tokens}
                          onChange={e => setParam('max_tokens', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.contextWindow')} min="1" placeholder={t('editProjectModal.defaultContextWindow')}
                          value={editingProject.model_params?.num_ctx}
                          onChange={e => setParam('num_ctx', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.seed')} min="0" placeholder={t('editProjectModal.defaultNone')}
                          value={editingProject.model_params?.seed}
                          onChange={e => setParam('seed', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.topP')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultOne')}
                          value={editingProject.model_params?.top_p}
                          onChange={e => setParam('top_p', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.frequencyPenalty')} step="0.1" min="-2" max="2" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.model_params?.frequency_penalty}
                          onChange={e => setParam('frequency_penalty', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.presencePenalty')} step="0.1" min="-2" max="2" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.model_params?.presence_penalty}
                          onChange={e => setParam('presence_penalty', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.topK')} min="1" placeholder={t('editProjectModal.defaultTopK')}
                          value={editingProject.model_params?.top_k}
                          onChange={e => setParam('top_k', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.minP')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.model_params?.min_p}
                          onChange={e => setParam('min_p', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.repetitionPenalty')} step="0.1" min="0" placeholder={t('editProjectModal.defaultOne')}
                          value={editingProject.model_params?.repetition_penalty}
                          onChange={e => setParam('repetition_penalty', parseNum(e.target.value, true))} />

                        <div className="flex flex-col" style={{ gap: '4px' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.reasoningEffort')}</label>
                          <select
                            className="vscode-settings-input"
                            value={editingProject.model_params?.reasoning_effort ?? ''}
                            onChange={e => setParam('reasoning_effort', e.target.value || undefined)}
                          >
                            <option value="">{t('editProjectModal.defaultOption')}</option>
                            <option value="none">{t('common.optionNone', 'None')}</option>
                            <option value="low">{t('common.optionLow', 'Low')}</option>
                            <option value="medium">{t('common.optionMedium', 'Medium')}</option>
                            <option value="high">{t('common.optionHigh', 'High')}</option>
                            <option value="xhigh">{t('common.optionXHigh', 'Extra high')}</option>
                          </select>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.thinking')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={!!editingProject.model_params?.think}
                              onChange={e => setEditingProject(p => ({ ...p, model_params: { ...p.model_params, think: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: '#cccccc' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.stream')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={editingProject.model_params?.stream ?? true}
                              onChange={e => setEditingProject(p => ({ ...p, model_params: { ...p.model_params, stream: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: '#cccccc' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>

                      </div>
                    </div>

                    {/* Agent params */}
                    <div>
                      <div style={{ color: '#9cdcfe', fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {t('editProjectModal.agentParams')}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <ParamNumber label={t('editProjectModal.maxHeartbeats')} min="1" placeholder={t('editProjectModal.defaultMemgptHeartbeats')}
                          value={editingProject.model_params?.max_heartbeats}
                          onChange={e => setParam('max_heartbeats', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.maxContextTokens')} min="1" placeholder={t('editProjectModal.defaultSameAsNumCtx')}
                          value={editingProject.model_params?.max_context_tokens}
                          onChange={e => setParam('max_context_tokens', parseNum(e.target.value))} />
                        <ParamNumber label={t('editProjectModal.evictionThreshold')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultOne')}
                          value={editingProject.model_params?.eviction_threshold}
                          onChange={e => setParam('eviction_threshold', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.memoryPressureThreshold')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultMemoryPressure')}
                          value={editingProject.model_params?.memory_pressure_threshold}
                          onChange={e => setParam('memory_pressure_threshold', parseNum(e.target.value, true))} />
                        <ParamNumber label={t('editProjectModal.loopDetectionLimit')} min="1" placeholder={t('editProjectModal.defaultLoopDetectionLimit')}
                          value={editingProject.model_params?.loop_detection_limit}
                          onChange={e => setParam('loop_detection_limit', parseNum(e.target.value))} />
                        
                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.loopDetection')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={editingProject.model_params?.loop_detection ?? true}
                              onChange={e => setEditingProject(p => ({ ...p, model_params: { ...p.model_params, loop_detection: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: '#cccccc' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>


                        <div className="flex flex-col" style={{ gap: '4px' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.responseMode')}</label>
                          <select
                            className="vscode-settings-input"
                            value={editingProject.model_params?.response_mode ?? 'last'}
                            onChange={e => setEditingProject(p => ({ ...p, model_params: { ...p.model_params, response_mode: e.target.value } }))}
                          >
                            <option value="all">{t('editProjectModal.responseModeAll')}</option>
                            <option value="last">{t('editProjectModal.responseModeLast')}</option>
                          </select>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.debug')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={!!editingProject.model_params?.debug}
                              onChange={e => setEditingProject(p => ({ ...p, model_params: { ...p.model_params, debug: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: '#cccccc' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* WORKER TAB */}
          {activeTab === 'worker' && (
            <div className="flex flex-col" style={{ gap: '14px' }}>
              {/* Worker Model */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.workerModel')}</label>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    list="edit-worker-models"
                    className="vscode-settings-input"
                    value={editingProject.worker_model || ''}
                    onChange={e => setProjectModel(e.target.value, 'worker')}
                    placeholder={t('editProjectModal.workerModelPlaceholder')}
                    style={{ flex: 1, borderColor: getBorderColor(workerModelStatus) }}
                  />
                  <datalist id="edit-worker-models">
                    {(globalModels || []).map(m => (
                      <option key={`edit-worker-model-${m.id}`} value={m.id} />
                    ))}
                  </datalist>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                  {workerHardware ? (
                    <span style={{ fontSize: '10px', color: '#888888' }}>
                      HW: {workerHardware.gpu_vram_gb}GB VRAM | {workerHardware.ram_gb}GB RAM
                    </span>
                  ) : (
                    <span style={{ fontSize: '10px', color: '#888888' }}>{t('editProjectModal.detectingHardware')}</span>
                  )}
                </div>
              </div>

              {/* Advanced params for Worker (collapsible) */}
              <div className="flex flex-col" style={{ marginTop: '4px' }}>
                <button
                  type="button"
                  onClick={() => setShowAdvancedParams(!showAdvancedParams)}
                  style={{ background: 'transparent', border: 'none', color: '#007acc', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 0', fontSize: '12px', fontWeight: 'bold', textAlign: 'left', width: 'fit-content' }}
                >
                  <span>{showAdvancedParams ? '▼' : '▶'} {t('editProjectModal.advancedWorker')}</span>
                </button>

                {showAdvancedParams && (
                  <div style={{ border: '1px solid var(--vscode-border)', borderRadius: '4px', padding: '12px', marginTop: '8px', backgroundColor: 'var(--vscode-input-bg)', display: 'flex', flexDirection: 'column', gap: '16px' }}>

                    {/* LiteLLM params */}
                    <div>
                      <div style={{ color: '#9cdcfe', fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {t('editProjectModal.litellmParams')}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <ParamNumber label={t('editProjectModal.temperature')} step="0.1" min="0" max="2" placeholder={t('editProjectModal.defaultTemperature')}
                          value={editingProject.worker_model_params?.temperature}
                          onChange={e => setParam('temperature', parseNum(e.target.value, true), true)} />
                        <ParamNumber label={t('editProjectModal.maxTokens')} min="1" placeholder={t('editProjectModal.unlimited')}
                          value={editingProject.worker_model_params?.max_tokens}
                          onChange={e => setParam('max_tokens', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.contextWindow')} min="1" placeholder={t('editProjectModal.defaultContextWindow')}
                          value={editingProject.worker_model_params?.num_ctx}
                          onChange={e => setParam('num_ctx', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.seed')} min="0" placeholder={t('editProjectModal.defaultNone')}
                          value={editingProject.worker_model_params?.seed}
                          onChange={e => setParam('seed', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.topP')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultOne')}
                          value={editingProject.worker_model_params?.top_p}
                          onChange={e => setParam('top_p', parseNum(e.target.value, true), true)} />
                        <ParamNumber label={t('editProjectModal.frequencyPenalty')} step="0.1" min="-2" max="2" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.worker_model_params?.frequency_penalty}
                          onChange={e => setParam('frequency_penalty', parseNum(e.target.value, true), true)} />
                        <ParamNumber label={t('editProjectModal.presencePenalty')} step="0.1" min="-2" max="2" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.worker_model_params?.presence_penalty}
                          onChange={e => setParam('presence_penalty', parseNum(e.target.value, true), true)} />
                        <ParamNumber label={t('editProjectModal.topK')} min="1" placeholder={t('editProjectModal.defaultTopK')}
                          value={editingProject.worker_model_params?.top_k}
                          onChange={e => setParam('top_k', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.minP')} step="0.05" min="0" max="1" placeholder={t('editProjectModal.defaultZero')}
                          value={editingProject.worker_model_params?.min_p}
                          onChange={e => setParam('min_p', parseNum(e.target.value, true), true)} />
                        <ParamNumber label={t('editProjectModal.repetitionPenalty')} step="0.1" min="0" placeholder={t('editProjectModal.defaultOne')}
                          value={editingProject.worker_model_params?.repetition_penalty}
                          onChange={e => setParam('repetition_penalty', parseNum(e.target.value, true), true)} />

                        <div className="flex flex-col" style={{ gap: '4px' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.reasoningEffort')}</label>
                          <select
                            className="vscode-settings-input"
                            value={editingProject.worker_model_params?.reasoning_effort ?? ''}
                            onChange={e => setParam('reasoning_effort', e.target.value || undefined, true)}
                          >
                            <option value="">{t('editProjectModal.defaultOption')}</option>
                            <option value="none">{t('common.optionNone', 'None')}</option>
                            <option value="low">{t('common.optionLow', 'Low')}</option>
                            <option value="medium">{t('common.optionMedium', 'Medium')}</option>
                            <option value="high">{t('common.optionHigh', 'High')}</option>
                            <option value="xhigh">{t('common.optionXHigh', 'Extra high')}</option>
                          </select>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.thinking')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={!!editingProject.worker_model_params?.think}
                              onChange={e => setEditingProject(p => ({ ...p, worker_model_params: { ...p.worker_model_params, think: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.stream')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={editingProject.worker_model_params?.stream ?? true}
                              onChange={e => setEditingProject(p => ({ ...p, worker_model_params: { ...p.worker_model_params, stream: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>
                      </div>
                    </div>

                    {/* Agent params */}
                    <div>
                      <div style={{ color: '#007acc', fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {t('editProjectModal.agentParams')}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <ParamNumber label={t('editProjectModal.maxIterationsWorker')} min="1" placeholder={t('editProjectModal.defaultUnlimited')}
                          value={editingProject.worker_model_params?.max_iterations}
                          onChange={e => setParam('max_iterations', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.maxToolCallsWorker')} min="1" placeholder={t('editProjectModal.defaultTopK')}
                          value={editingProject.worker_model_params?.max_tool_calls}
                          onChange={e => setParam('max_tool_calls', parseNum(e.target.value), true)} />
                        <ParamNumber label={t('editProjectModal.loopDetectionLimit')} min="1" placeholder={t('editProjectModal.defaultLoopDetectionLimit')}
                          value={editingProject.worker_model_params?.loop_detection_limit}
                          onChange={e => setParam('loop_detection_limit', parseNum(e.target.value), true)} />
                        
                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.loopDetection')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={editingProject.worker_model_params?.loop_detection ?? true}
                              onChange={e => setEditingProject(p => ({ ...p, worker_model_params: { ...p.worker_model_params, loop_detection: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>

                        <div className="flex flex-col" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                          <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.debug')}</label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox"
                              checked={!!editingProject.worker_model_params?.debug}
                              onChange={e => setEditingProject(p => ({ ...p, worker_model_params: { ...p.worker_model_params, debug: e.target.checked } }))} />
                            <span style={{ fontSize: '12px', color: 'var(--vscode-text-fg)' }}>{t('editProjectModal.enabled')}</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {editProjError && (
            <div style={{ color: '#f48771', fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
              ⚠️ {editProjError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '12px', borderTop: '1px solid var(--vscode-border)', marginTop: '4px' }}>
            <button type="button" onClick={onClose} className="vscode-button" style={{ background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('editProjectModal.cancel')}
            </button>
            <button type="submit" className="vscode-button">
              <Check size={12} />
              {t('editProjectModal.saveChanges')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
