import React from 'react';
import { X, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_PRESETS,
  UI_SCALE_STEP,
  presetForScale,
} from '../../utils/uiScale';
import { useCustomDialog } from './CustomDialogProvider';
import i18n from '../../i18n/index.js';
import { safeSetLocalStorage } from '../../utils/storage';

// Target languages offered by the "Translate to" setting. The values are the
// locale codes persisted by /api/settings/translation; "" follows the UI
// language and TRANSLATE_CUSTOM switches the field to free-text entry.
const TRANSLATE_LANGUAGES = [
  { value: 'pt-BR', labelKey: 'settingsModal.translateLangPtBR', label: 'Portugu\u00eas (Brasil)' },
  { value: 'en', labelKey: 'settingsModal.translateLangEn', label: 'English' },
  { value: 'es', labelKey: 'settingsModal.translateLangEs', label: 'Espa\u00f1ol' },
  { value: 'fr', labelKey: 'settingsModal.translateLangFr', label: 'Fran\u00e7ais' },
  { value: 'de', labelKey: 'settingsModal.translateLangDe', label: 'Deutsch' },
  { value: 'it', labelKey: 'settingsModal.translateLangIt', label: 'Italiano' },
  { value: 'ja', labelKey: 'settingsModal.translateLangJa', label: '\u65e5\u672c\u8a9e' },
  { value: 'zh', labelKey: 'settingsModal.translateLangZh', label: '\u4e2d\u6587' },
  { value: 'ru', labelKey: 'settingsModal.translateLangRu', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },
];

const TRANSLATE_CUSTOM = '__custom__';

// IDE global settings modal (theme, font size, tab size, word wrap, minimap, optional deps).
export default function SettingsModal({
  onClose,
  settingsTab,
  setSettingsTab,
  theme,
  setTheme,
  uiScale,
  applyUiScale,
  editorFontSize,
  setEditorFontSize,
  editorTabSize,
  setEditorTabSize,
  editorWordWrap,
  setEditorWordWrap,
  editorMinimap,
  setEditorMinimap,
  isInstallingDeps,
  installDepsStatus,
  installDepsLog,
  onInstallDeps,
  onLanguageChange,
  ephemeralParams,
  setEphemeralParams,
  panelMaxLines,
  setPanelMaxLines,
}) {
  const { t } = useTranslation();
  const { showAlert, showConfirm } = useCustomDialog();
  const [selectedLang, setSelectedLang] = React.useState('');
  const [opalatexHome, setOpalaTexHome] = React.useState('');
  const [opalatexHomeError, setOpalaTexHomeError] = React.useState('');
  const [draftSynctexEnabled, setDraftSynctexEnabled] = React.useState(false);
  const [workspaceHiddenExtensions, setWorkspaceHiddenExtensions] = React.useState([]);
  const [tectonicInstallMessage, setTectonicInstallMessage] = React.useState('');
  const [pandocInstallMessage, setPandocInstallMessage] = React.useState('');
  const [promptEvolutionIterations, setPromptEvolutionIterations] = React.useState(1);
  const [promptEvolutionMaxTokens, setPromptEvolutionMaxTokens] = React.useState(4096);
  const [translateTargetLang, setTranslateTargetLang] = React.useState('');
  const [isCustomTranslateLang, setIsCustomTranslateLang] = React.useState(false);
  const [imageGen, setImageGen] = React.useState({ enabled: true, model: '', size: '1024x1024', output_dir: 'figures' });
  const [imageModels, setImageModels] = React.useState([]);
  const [isRestarting, setIsRestarting] = React.useState(false);

  const activeTab = (settingsTab === 'preferences' || !['general', 'dependencies', 'about'].includes(settingsTab))
    ? 'general'
    : settingsTab;

  React.useEffect(() => {
    fetch('/api/settings/language')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg?.lang !== undefined) setSelectedLang(cfg.lang); })
      .catch(() => { });

    fetch('/api/settings/opalatexhome')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        // A configured directory the backend could not open is reported here
        // rather than silently replaced by the fallback it is actually using.
        setOpalaTexHomeError(data.error || '');
        const shown = data.error ? (data.configured_path || data.path) : data.path;
        if (shown) setOpalaTexHome(shown);
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

    fetch('/api/settings/image-generation')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        const { models, routes, ...rest } = cfg;
        setImageGen(prev => ({ ...prev, ...rest }));
        setImageModels(Array.isArray(models) ? models : []);
      })
      .catch(() => { });

    fetch('/api/settings/translation')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        const saved = String(cfg.translate_target_lang || '');
        setTranslateTargetLang(saved);
        setIsCustomTranslateLang(Boolean(saved) && !TRANSLATE_LANGUAGES.some(l => l.value === saved));
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

  const saveLatexSettings = (draftSynctexValue) => {
    fetch('/api/settings/latex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_synctex_enabled: draftSynctexValue }),
    }).catch(() => { });
  };

  const saveImageGenSettings = (next) => {
    setImageGen(next);
    fetch('/api/settings/image-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => { });
  };

  const saveTranslateTargetLang = (value) => {
    fetch('/api/settings/translation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translate_target_lang: value }),
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

  // Saving OPALATEX_HOME only takes effect on the next launch, so the user is
  // asked right away whether to restart; declining leaves the saved value in
  // place with a reminder that it is still pending.
  const saveOpalaTexHome = async () => {
    let data;
    try {
      const res = await fetch('/api/settings/opalatexhome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: opalatexHome })
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const message = data?.error || String(res.status);
        setOpalaTexHomeError(message);
        await showAlert(t('settingsModal.globalDataDirError') + message);
        return;
      }
      setOpalaTexHomeError('');
    } catch (err) {
      setOpalaTexHomeError(String(err));
      await showAlert(t('settingsModal.globalDataDirError') + err);
      return;
    }

    if (!data?.requiresRestart) {
      await showAlert(t('settingsModal.globalDataDirSaved'));
      return;
    }

    const shouldRestart = await showConfirm(t('settingsModal.globalDataDirRestartConfirm'));
    if (!shouldRestart) {
      await showAlert(t('settingsModal.globalDataDirRestartAlert'));
      return;
    }

    setIsRestarting(true);
    try {
      const res = await fetch('/api/app/restart', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) {
        setIsRestarting(false);
        await showAlert(t('settingsModal.restartError') + (body?.error || res.status));
      }
      // On success the server exits and relaunches; this window closes with it.
    } catch (err) {
      setIsRestarting(false);
      await showAlert(t('settingsModal.restartError') + err);
    }
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
      <div className="vscode-modal flex flex-col" style={{ width: '640px', maxHeight: 'calc(85 * var(--ui-vh))', padding: 0 }}>
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

              {/* Theme */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.colorTheme')}</label>
                <select value={theme} onChange={(e) => setTheme(e.target.value)} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="dark">{t('settingsModal.themeDark')}</option>
                  <option value="light">{t('settingsModal.themeLight')}</option>
                </select>
              </div>

              {/* Interface size (accessibility) — scales the whole interface,
                  not just text, so icons, padding and click targets grow with
                  it. The named steps cover the common case; the slider below
                  reaches further for those who need it. */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('settingsModal.interfaceSize', 'Interface size')}
                </label>
                <div className="flex" style={{ gap: '6px' }}>
                  {UI_SCALE_PRESETS.map((preset) => {
                    const isActive = presetForScale(uiScale)?.id === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyUiScale(preset.scale)}
                        aria-pressed={isActive}
                        className="vscode-settings-input"
                        style={{
                          flex: 1,
                          cursor: 'pointer',
                          textAlign: 'center',
                          borderColor: isActive ? 'var(--vscode-accent)' : 'var(--vscode-input-border)',
                          background: isActive ? 'var(--vscode-list-activeSelectionBg)' : 'var(--vscode-input-bg)',
                          color: isActive ? 'var(--vscode-list-activeSelectionFg)' : 'var(--vscode-input-fg)',
                        }}
                      >
                        {t(`settingsModal.interfaceSize_${preset.id}`, preset.id)}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center" style={{ gap: '8px' }}>
                  <input
                    type="range"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={UI_SCALE_STEP}
                    value={uiScale}
                    onChange={(e) => applyUiScale(Number(e.target.value))}
                    aria-label={t('settingsModal.interfaceSize', 'Interface size')}
                    style={{ flex: 1, accentColor: 'var(--vscode-accent)' }}
                  />
                  <span style={{ minWidth: '48px', textAlign: 'right', color: 'var(--vscode-text-fg)' }}>
                    {Math.round(uiScale * 100)}%
                  </span>
                </div>
                <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.interfaceSizeHint', 'Scales the whole interface, not just text. Also available anywhere with Ctrl+Shift+Plus, Ctrl+Shift+Minus and Ctrl+Shift+0.')}
                </span>
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

              {/* Minimap */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.minimap')}</label>
                <select value={editorMinimap} onChange={(e) => { setEditorMinimap(e.target.value); safeSetLocalStorage('editorMinimap', e.target.value); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="on">{t('settingsModal.minimapOn')}</option>
                  <option value="off">{t('settingsModal.minimapOff')}</option>
                </select>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.minimapHint')}</span>
              </div>

              {/* Translate to (PDF viewer translation target) */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.translateTo', 'Translate to')}</label>
                <select
                  value={isCustomTranslateLang ? TRANSLATE_CUSTOM : translateTargetLang}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === TRANSLATE_CUSTOM) {
                      setIsCustomTranslateLang(true);
                      return;
                    }
                    setIsCustomTranslateLang(false);
                    setTranslateTargetLang(value);
                    saveTranslateTargetLang(value);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="">{t('settingsModal.translateToInterface', 'Same as interface language')}</option>
                  {TRANSLATE_LANGUAGES.map(lang => (
                    <option key={lang.value} value={lang.value}>{t(lang.labelKey, lang.label)}</option>
                  ))}
                  <option value={TRANSLATE_CUSTOM}>{t('settingsModal.translateToOther', 'Other (type a language)')}</option>
                </select>
                {isCustomTranslateLang && (
                  <input
                    type="text"
                    value={translateTargetLang}
                    placeholder={t('settingsModal.translateToOtherPlaceholder', 'e.g. Norwegian')}
                    onChange={(e) => setTranslateTargetLang(e.target.value)}
                    onBlur={(e) => saveTranslateTargetLang(e.target.value.trim())}
                    className="vscode-settings-input"
                    style={{ width: '100%' }}
                  />
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.translateToHint', 'Target language used by the PDF viewer\'s "Translate selection" action.')}
                </span>
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

              {/* Image generation */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.imageGeneration')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' }}>
                  <input
                    type="checkbox"
                    checked={!!imageGen.enabled}
                    onChange={(e) => saveImageGenSettings({ ...imageGen, enabled: e.target.checked })}
                  />
                  {t('settingsModal.imageGenerationEnabled')}
                </label>

                {imageModels.length === 0 ? (
                  <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                    {t('settingsModal.imageGenerationNoModels')}
                  </span>
                ) : (
                  <>
                    <select
                      className="vscode-settings-input"
                      style={{ width: '100%' }}
                      value={imageGen.model || ''}
                      onChange={(e) => saveImageGenSettings({ ...imageGen, model: e.target.value })}
                    >
                      <option value="">{t('settingsModal.imageGenerationModelPlaceholder')}</option>
                      {imageModels.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.id}{m.connection_label ? ` (${m.connection_label})` : ''}
                        </option>
                      ))}
                    </select>
                    <div className="flex" style={{ gap: '8px' }}>
                      <div className="flex flex-col" style={{ gap: '4px', flex: 1 }}>
                        <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.imageGenerationSize')}</label>
                        <input
                          type="text"
                          className="vscode-settings-input"
                          value={imageGen.size || ''}
                          placeholder="1024x1024"
                          onChange={(e) => setImageGen({ ...imageGen, size: e.target.value })}
                          onBlur={() => saveImageGenSettings(imageGen)}
                        />
                      </div>
                      <div className="flex flex-col" style={{ gap: '4px', flex: 1 }}>
                        <label style={{ fontSize: '11px', color: '#a0a0a0' }}>{t('settingsModal.imageGenerationOutputDir')}</label>
                        <input
                          type="text"
                          className="vscode-settings-input"
                          value={imageGen.output_dir || ''}
                          placeholder="figures"
                          onChange={(e) => setImageGen({ ...imageGen, output_dir: e.target.value })}
                          onBlur={() => saveImageGenSettings(imageGen)}
                        />
                      </div>
                    </div>
                  </>
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.imageGenerationHint')}
                </span>
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
                    onClick={saveOpalaTexHome}
                    disabled={isRestarting}
                    className="vscode-button"
                  >
                    {isRestarting ? t('settingsModal.restarting') : t('settingsModal.save')}
                  </button>
                </div>
                {opalatexHomeError && (
                  <span style={{ fontSize: '11px', color: '#f48771' }}>{opalatexHomeError}</span>
                )}
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

          {activeTab === 'about' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--vscode-text-fg)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.version')}</span>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--vscode-text-fg)' }}>0.2.6</span>
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
                  <span style={{ fontSize: '11px', color: 'var(--vscode-description-fg, #aaaaaa)' }}>
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
