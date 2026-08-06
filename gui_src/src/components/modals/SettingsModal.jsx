import React from 'react';
import { X, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './CustomDialogProvider';
import i18n from '../../i18n/index.js';
import { safeSetLocalStorage } from '../../utils/storage';
import { FEATURES } from '../../config/features';

// IDE global settings modal (theme, font size, tab size, word wrap, optional deps).
export default function SettingsModal({
  onClose,
  settingsTab,
  setSettingsTab,
  theme,
  setTheme,
  editorFontSize,
  setEditorFontSize,
  editorTabSize,
  setEditorTabSize,
  editorWordWrap,
  setEditorWordWrap,
  isInstallingDeps,
  installDepsStatus,
  installDepsLog,
  onInstallDeps,
  onLanguageChange,
  ephemeralParams,
  setEphemeralParams,
  panelMaxLines,
  setPanelMaxLines,
  globalCloudModel = 'OpalaTexCloud',
  onCloudModelChange,
  onAiProviderChange,
  licenseData,
  onReplaceSerial,
}) {
  const { t } = useTranslation();
  const { showAlert } = useCustomDialog();
  const [selectedLang, setSelectedLang] = React.useState('');
  const [opalatexHome, setOpalaTexHome] = React.useState('');
  const [aiProvider, setAiProvider] = React.useState('local');
  const [cloudModel, setCloudModel] = React.useState(globalCloudModel);
  const [draftSynctexEnabled, setDraftSynctexEnabled] = React.useState(false);
  const [workspaceHiddenExtensions, setWorkspaceHiddenExtensions] = React.useState([]);
  const [tectonicInstallMessage, setTectonicInstallMessage] = React.useState('');
  const [pandocInstallMessage, setPandocInstallMessage] = React.useState('');
  const [promptEvolutionIterations, setPromptEvolutionIterations] = React.useState(1);
  const [promptEvolutionMaxTokens, setPromptEvolutionMaxTokens] = React.useState(4096);

  const activeTab = (settingsTab === 'preferences' || !['general', 'dependencies', 'license', 'about'].includes(settingsTab))
    ? 'general'
    : settingsTab;

  const cloudModelOptions = [
    { value: 'OpalaTexCloud', label: t('editProjectModal.opalaCloudLiteOption', 'OpalaTex Live (standard credit use)') },
    { value: 'OpalaTexCloudGemini35Flash', label: t('editProjectModal.opalaCloudFlashOption', 'OpalaTex Flash (4x credit use)') },
  ];
  const normalizeCloudModel = (value) => cloudModelOptions.some(option => option.value === value) ? value : 'OpalaTexCloud';

  React.useEffect(() => {
    setCloudModel(normalizeCloudModel(globalCloudModel));
  }, [globalCloudModel]);

  React.useEffect(() => {
    fetch('/api/settings/language')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg?.lang !== undefined) setSelectedLang(cfg.lang); })
      .catch(() => { });

    fetch('/api/settings/opalatexhome')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.path) setOpalaTexHome(data.path); })
      .catch(() => { });

    fetch('/api/settings/ai-provider')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.provider !== undefined) {
          const effectiveProvider = (!FEATURES.enableCloudAccount && cfg.provider === 'cloud') ? 'local' : cfg.provider;
          setAiProvider(effectiveProvider);
        }
      })
      .catch(() => { });

    fetch('/api/settings/latex')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.draft_synctex_enabled !== undefined) {
          setDraftSynctexEnabled(Boolean(cfg.draft_synctex_enabled));
        }
      })
      .catch(() => { });

    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (Array.isArray(cfg?.hidden_file_extensions)) {
          setWorkspaceHiddenExtensions(cfg.hidden_file_extensions);
        }
      })
      .catch(() => { });

    fetch('/api/settings/prompt-evolution')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.prompt_evolution_iterations !== undefined) {
          setPromptEvolutionIterations(Math.max(1, Number(cfg.prompt_evolution_iterations) || 1));
        }
        if (cfg?.prompt_evolution_max_tokens !== undefined) {
          setPromptEvolutionMaxTokens(Math.max(1, Number(cfg.prompt_evolution_max_tokens) || 4096));
        }
      })
      .catch(() => { });
  }, []);

  const saveAiProviderSettings = (providerValue, cloudModelValue) => {
    fetch('/api/settings/ai-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerValue, cloud_model: cloudModelValue }),
    }).catch(() => { });
  };

  const saveLatexSettings = (draftSynctexValue) => {
    fetch('/api/settings/latex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_synctex_enabled: draftSynctexValue }),
    }).catch(() => { });
  };

  const savePromptEvolutionSettings = (iterations, maxTokens) => {
    const numIterations = Math.max(1, Math.floor(Number(iterations) || 1));
    const numMaxTokens = Math.max(1, Math.min(65536, Math.floor(Number(maxTokens) || 4096)));
    fetch('/api/settings/prompt-evolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_evolution_iterations: numIterations, prompt_evolution_max_tokens: numMaxTokens }),
    }).catch(() => { });
  };

  const updateEphemeralParam = (key, val) => {
    const updated = { ...ephemeralParams };
    if (val === '' || val === undefined) delete updated[key];
    else updated[key] = val;
    setEphemeralParams(updated);
    safeSetLocalStorage('ephemeralParams', JSON.stringify(updated));
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '640px', maxHeight: '85vh', padding: 0 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--vscode-border)', backgroundColor: 'var(--vscode-titlebar-bg)' }}>
          <div className="flex items-center" style={{ gap: '8px' }}>
            <Settings size={16} />
            <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{t('settingsModal.title')}</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--vscode-text-fg)', cursor: 'pointer', padding: '2px' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-4" style={{ borderBottom: '1px solid var(--vscode-border)', gap: '16px', backgroundColor: 'var(--vscode-titlebar-bg)' }}>
          <button
            onClick={() => setSettingsTab('general')}
            style={{
              background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'general' ? 'bold' : 'normal',
              color: activeTab === 'general' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
              borderBottom: activeTab === 'general' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
            }}
          >
            {t('settingsModal.tabGeneral', 'General')}
          </button>
          <button
            onClick={() => setSettingsTab('dependencies')}
            style={{
              background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'dependencies' ? 'bold' : 'normal',
              color: activeTab === 'dependencies' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
              borderBottom: activeTab === 'dependencies' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
            }}
          >
            {t('settingsModal.tabDependencies', 'Dependencies')}
          </button>
          {FEATURES.enableCloudAccount && (
            <button
              onClick={() => setSettingsTab('license')}
              style={{
                background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'license' ? 'bold' : 'normal',
                color: activeTab === 'license' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
                borderBottom: activeTab === 'license' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
              }}
            >
              {t('settingsModal.tabAccount', 'Opala Cloud Account')}
            </button>
          )}
          <button
            onClick={() => setSettingsTab('about')}
            style={{
              background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'about' ? 'bold' : 'normal',
              color: activeTab === 'about' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
              borderBottom: activeTab === 'about' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
            }}
          >
            {t('settingsModal.tabAbout')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col" style={{ gap: '16px' }}>
          {activeTab === 'general' && (
            <>
              {/* Language */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.language')}</label>
                <select
                  value={selectedLang}
                  onChange={(e) => {
                    const newLang = e.target.value;
                    setSelectedLang(newLang);
                    const targetLang = newLang || (navigator.language.startsWith('pt') ? 'pt-BR' : 'en');
                    i18n.changeLanguage(targetLang);
                    onLanguageChange?.(newLang);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="">{t('settingsModal.languageSystem', 'System (automatic)')}</option>
                  <option value="pt-BR">{t('settingsModal.languagePtBR', 'Português (Brasil)')}</option>
                  <option value="en">{t('settingsModal.languageEn', 'English')}</option>
                </select>
              </div>

              {/* AI Provider */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.aiProvider')}</label>
                <select
                  value={aiProvider}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAiProvider(val);
                    onAiProviderChange?.(val);
                    saveAiProviderSettings(val, cloudModel);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="local">{t('settingsModal.aiProviderLocal')}</option>
                  {FEATURES.enableCloudAccount && (
                    <option value="cloud">{t('settingsModal.aiProviderCloud')}</option>
                  )}
                </select>
                <span style={{ fontSize: '11px', color: '#888888' }}>
                  {t('settingsModal.aiProviderHint')}
                </span>
              </div>

              {FEATURES.enableCloudModels && FEATURES.enableCloudAccount && aiProvider === 'cloud' && (
                <div className="flex flex-col" style={{ gap: '6px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.cloudModel')}</label>
                  <select
                    value={normalizeCloudModel(cloudModel)}
                    onChange={(e) => {
                      const val = normalizeCloudModel(e.target.value);
                      setCloudModel(val);
                      onCloudModelChange?.(val);
                      saveAiProviderSettings(aiProvider, val);
                    }}
                    className="vscode-settings-input"
                    style={{ width: '100%' }}
                  >
                    {cloudModelOptions.map(option => (
                      <option key={`settings-cloud-model-${option.value}`} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: '11px', color: '#888888' }}>
                    {t('settingsModal.cloudModelHint')}
                  </span>
                </div>
              )}

              {/* Theme */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.colorTheme')}</label>
                <select value={theme} onChange={(e) => setTheme(e.target.value)} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="dark">{t('settingsModal.themeDark')}</option>
                  <option value="light">{t('settingsModal.themeLight')}</option>
                </select>
              </div>

              {/* Font size */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.editorFontSize')}</label>
                <input
                  type="number" min="10" max="30" value={editorFontSize}
                  onChange={(e) => { const val = Number(e.target.value); setEditorFontSize(val); safeSetLocalStorage('editorFontSize', val); }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
              </div>

              {/* Tab size */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.tabSize')}</label>
                <select value={editorTabSize} onChange={(e) => { const val = Number(e.target.value); setEditorTabSize(val); safeSetLocalStorage('editorTabSize', val); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value={2}>{t('settingsModal.twoSpaces')}</option>
                  <option value={4}>{t('settingsModal.fourSpaces')}</option>
                  <option value={8}>{t('settingsModal.eightSpaces')}</option>
                </select>
              </div>

              {/* Word wrap */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.wordWrap')}</label>
                <select value={editorWordWrap} onChange={(e) => { setEditorWordWrap(e.target.value); safeSetLocalStorage('editorWordWrap', e.target.value); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="on">{t('settingsModal.wordWrapOn')}</option>
                  <option value="off">{t('settingsModal.wordWrapOff')}</option>
                </select>
              </div>

              {/* Prompt Evolution Iterations */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.promptEvolutionIterations', 'Prompt Evolution Iterations')}</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={promptEvolutionIterations}
                  onChange={(e) => {
                    const val = Math.max(1, Math.floor(Number(e.target.value) || 1));
                    setPromptEvolutionIterations(val);
                    savePromptEvolutionSettings(val, promptEvolutionMaxTokens);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.promptEvolutionIterationsHint', 'Number of refinement iterations executed when evolving a prompt (default: 1).')}
                </span>
              </div>

              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.promptEvolutionMaxTokens', 'Prompt Evolution Max Tokens')}</label>
                <input
                  type="number"
                  min="1"
                  max="65536"
                  step="1"
                  value={promptEvolutionMaxTokens}
                  onChange={(e) => {
                    const val = Math.max(1, Math.min(65536, Math.floor(Number(e.target.value) || 4096)));
                    setPromptEvolutionMaxTokens(val);
                    savePromptEvolutionSettings(promptEvolutionIterations, val);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.promptEvolutionMaxTokensHint', 'Maximum generated tokens for each prompt-evolution iteration (default: 4096).')}
                </span>
              </div>
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.latexCompilation')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' }}>
                  <input
                    type="checkbox"
                    checked={draftSynctexEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftSynctexEnabled(checked);
                      saveLatexSettings(checked);
                    }}
                  />
                  <span>{t('settingsModal.draftSynctexEnabled')}</span>
                </label>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.draftSynctexHint')}</span>
              </div>

              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.workspaceFiles')}</label>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                  {t('settingsModal.hiddenFileExtensionsHint', {
                    extensions: workspaceHiddenExtensions.join(', '),
                  })}
                </span>
              </div>

              {/* Panel max lines */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.panelMaxLines')}</label>
                <input
                  type="number" min="100" max="10000" step="100"
                  value={panelMaxLines}
                  onChange={(e) => {
                    const val = Math.max(100, Math.min(10000, Number(e.target.value) || 1000));
                    setPanelMaxLines(val);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '11px', color: '#888888' }}>{t('settingsModal.panelMaxLinesHint')}</span>
              </div>

              {/* Global Data Directory */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.globalDataDir')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={opalatexHome}
                    onChange={(e) => setOpalaTexHome(e.target.value)}
                    className="vscode-settings-input"
                    style={{ flex: 1 }}
                    placeholder={t('settingsModal.globalDataDirPlaceholder')}
                  />
                  <button
                    onClick={() => {
                      fetch('/api/settings/opalatexhome', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: opalatexHome })
                      })
                        .then(async res => {
                          if (res.requiresRestart) {
                            await showAlert(t('settingsModal.globalDataDirRestartAlert'));
                          } else if (res.error) {
                            await showAlert(t('settingsModal.globalDataDirError') + res.error);
                          }
                        });
                    }}
                    className="vscode-button"
                  >
                    {t('settingsModal.save')}
                  </button>
                </div>
                <span style={{ fontSize: '11px', color: '#888888' }}>{t('settingsModal.globalDataDirHint')}</span>
              </div>



              {/* Ephemeral Agent Settings */}
              <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.ephemeralAgentTitle')}</label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralMaxTokens')}</label>
                    <input type="number" min="1" className="vscode-settings-input" placeholder={t('settingsModal.ephemeralUnlimited')}
                      value={ephemeralParams?.max_tokens || ''}
                      onChange={e => updateEphemeralParam('max_tokens', e.target.value ? Number(e.target.value) : undefined)} />
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralContextWindow')}</label>
                    <input type="number" min="1" className="vscode-settings-input" placeholder={t('settingsModal.ephemeralContextWindowPlaceholder')}
                      value={ephemeralParams?.num_ctx || ''}
                      onChange={e => updateEphemeralParam('num_ctx', e.target.value ? Number(e.target.value) : undefined)} />
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralTemperature')}</label>
                    <input type="number" step="0.1" min="0" max="2" className="vscode-settings-input" placeholder="0.7"
                      value={ephemeralParams?.temperature ?? ''}
                      onChange={e => updateEphemeralParam('temperature', e.target.value ? parseFloat(e.target.value) : undefined)} />
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralReasoningEffort')}</label>
                    <select className="vscode-settings-input"
                      value={ephemeralParams?.reasoning_effort || 'none'}
                      onChange={e => updateEphemeralParam('reasoning_effort', e.target.value)}>
                      <option value="none">{t('common.optionNone', 'None')}</option>
                      <option value="low">{t('common.optionLow', 'Low')}</option>
                      <option value="medium">{t('common.optionMedium', 'Medium')}</option>
                      <option value="high">{t('common.optionHigh', 'High')}</option>
                      <option value="xhigh">{t('common.optionXHigh', 'Extra high')}</option>
                    </select>
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralThink', 'Think Parameter')}</label>
                    <select className="vscode-settings-input"
                      value={ephemeralParams?.think === undefined ? 'false' : (ephemeralParams.think ? 'true' : 'false')}
                      onChange={e => {
                        updateEphemeralParam('think', e.target.value === 'true');
                      }}>
                      <option value="true">{t('common.optionTrue', 'True')}</option>
                      <option value="false">{t('common.optionFalse', 'False')}</option>
                    </select>
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralResponseMode', 'Response Mode')}</label>
                    <select className="vscode-settings-input"
                      value={ephemeralParams?.response_mode || 'last'}
                      onChange={e => updateEphemeralParam('response_mode', e.target.value)}>
                      <option value="last">{t('settingsModal.ephemeralLastDefault', 'last (default)')}</option>
                      <option value="all">{t('common.optionAll', 'All')}</option>
                    </select>
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralMaxIterations')}</label>
                    <input type="number" min="1" className="vscode-settings-input" placeholder="10"
                      value={ephemeralParams?.max_iterations || ''}
                      onChange={e => updateEphemeralParam('max_iterations', e.target.value ? Number(e.target.value) : undefined)} />
                  </div>
                  <div className="flex flex-col" style={{ gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.ephemeralMaxToolCalls')}</label>
                    <input type="number" min="1" className="vscode-settings-input" placeholder="10"
                      value={ephemeralParams?.max_tool_calls || ''}
                      onChange={e => updateEphemeralParam('max_tool_calls', e.target.value ? Number(e.target.value) : undefined)} />
                  </div>
                </div>
              </div>

            </>
          )}

          {activeTab === 'dependencies' && (
            <>
              {/* Install Tectonic */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.installTectonicTitle')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setTectonicInstallMessage('');
                      const btn = document.getElementById('btnInstallTectonic');
                      if (btn) btn.disabled = true;
                      fetch('/api/settings/install-tectonic', { method: 'POST' })
                        .then(r => r.json())
                        .then(async res => {
                          if (res.success) {
                            setTectonicInstallMessage(t('settingsModal.installTectonicSuccess'));
                          } else {
                            await showAlert(t('settingsModal.installTectonicError') + res.error);
                          }
                          if (btn) btn.disabled = false;
                        })
                        .catch(async err => {
                          await showAlert(t('settingsModal.connectionError') + err);
                          if (btn) btn.disabled = false;
                        });
                    }}
                    id="btnInstallTectonic"
                    className="vscode-button"
                  >
                    {t('settingsModal.installTectonicBtn')}
                  </button>
                </div>
                {tectonicInstallMessage && (
                  <span role="status" style={{ fontSize: '11px', color: 'var(--battery-good)' }}>
                    {tectonicInstallMessage}
                  </span>
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.installTectonicHint')}</span>
              </div>

              {/* Install Pandoc */}
              <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.installPandocTitle')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setPandocInstallMessage('');
                      const btn = document.getElementById('btnInstallPandoc');
                      if (btn) btn.disabled = true;
                      fetch('/api/settings/install-pandoc', { method: 'POST' })
                        .then(r => r.json())
                        .then(async res => {
                          if (res.success) {
                            setPandocInstallMessage(t('settingsModal.installPandocSuccess'));
                          } else {
                            await showAlert(t('settingsModal.installPandocError') + res.error);
                          }
                          if (btn) btn.disabled = false;
                        })
                        .catch(async err => {
                          await showAlert(t('settingsModal.connectionError') + err);
                          if (btn) btn.disabled = false;
                        });
                    }}
                    id="btnInstallPandoc"
                    className="vscode-button"
                  >
                    {t('settingsModal.installPandocBtn')}
                  </button>
                </div>
                {pandocInstallMessage && (
                  <span role="status" style={{ fontSize: '11px', color: 'var(--battery-good)' }}>
                    {pandocInstallMessage}
                  </span>
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.installPandocHint')}</span>
              </div>
            </>
          )}

          {FEATURES.enableCloudAccount && activeTab === 'license' && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '12px',
              border: '1px solid var(--vscode-border)',
              borderRadius: '6px',
              backgroundColor: 'var(--vscode-sidebar-bg)'
            }}>
              <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.softwareSerial')}</span>
              <input
                type="text"
                readOnly
                value={licenseData?.key || t('settingsModal.noSoftwareSerial')}
                className="vscode-settings-input"
                style={{
                  width: '100%',
                  fontFamily: 'monospace',
                  color: licenseData?.key ? 'var(--vscode-text-fg)' : 'var(--vscode-description-fg, #aaaaaa)',
                  cursor: 'default'
                }}
              />
              <span style={{ fontSize: '11px', color: 'var(--vscode-description-fg, #aaaaaa)', lineHeight: '1.4' }}>
                {t('settingsModal.softwareSerialHint')}
              </span>
              <button
                className="vscode-button"
                style={{ alignSelf: 'flex-start' }}
                onClick={onReplaceSerial}
              >
                {t('settingsModal.replaceSoftwareSerial')}
              </button>
            </div>
          )}

          {activeTab === 'about' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--vscode-text-fg)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.version')}</span>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--vscode-text-fg)' }}>0.1.9</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.author')}</span>
                <span style={{ fontSize: '13px', color: 'var(--vscode-text-fg)' }}>
                  dev@opalacoder.com</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.license')}</span>
                <span style={{ fontSize: '13px', color: 'var(--vscode-text-fg)' }}>MIT</span>
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                marginTop: '6px',
                padding: '16px',
                border: '1px solid var(--vscode-border)',
                borderRadius: '8px',
                backgroundColor: 'var(--vscode-sidebar-bg)'
              }}>
                <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.donationTitle')}</span>
                  <span style={{ fontSize: '12px', lineHeight: '1.5', color: 'var(--vscode-description-fg, #aaaaaa)' }}>
                    {t('settingsModal.donationDescription')}
                  </span>
                  <button
                    className="vscode-button"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => window.open('https://www.paypal.com/donate/?business=DKWJSCLDJG6XY&no_recurring=0&item_name=Manuten%C3%A7%C3%A3o+do+Software+Open+Source+OpalaTex&currency_code=BRL', '_blank')}
                  >
                    {t('settingsModal.donationButton')}
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
                  <img
                    src="/qr-code.png"
                    alt={t('settingsModal.donationQrAlt')}
                    style={{ width: '132px', height: '132px', objectFit: 'contain', padding: '6px', backgroundColor: '#ffffff', borderRadius: '6px' }}
                  />
                  <span style={{ fontSize: '10px', color: 'var(--vscode-description-fg, #aaaaaa)' }}>
                    {t('settingsModal.donationScan')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', gap: '8px', borderTop: '1px solid var(--vscode-border)', backgroundColor: 'var(--vscode-sidebar-bg)' }}>
          <button onClick={onClose} className="vscode-button">{t('settingsModal.close')}</button>
        </div>
      </div>
    </div>
  );
}
