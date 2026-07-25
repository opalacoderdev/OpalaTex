import React, { useState, useEffect } from 'react';
import { Loader2, Monitor, Cloud, Terminal, CheckCircle, X, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FEATURES from '../../config/features';

export default function OnboardingModal({ onClose, onComplete }) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState(1);
  const [hardware, setHardware] = useState(null);
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [isInstalling, setIsInstalling] = useState(false);

  const [apiProvider, setApiProvider] = useState('gemini/gemini-flash-lite-latest');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');

  const [licenseStatus, setLicenseStatus] = useState(null);

  useEffect(() => {
    fetch('/api/hardware')
      .then(res => res.json())
      .then(data => setHardware(data))
      .catch(console.error);

    fetch('/api/ollama/status')
      .then(res => res.json())
      .then(data => setOllamaStatus(data))
      .catch(console.error);

    if (FEATURES.enableCloudAccount) {
      fetch('/api/license/status')
        .then(res => res.json())
        .then(data => setLicenseStatus(data))
        .catch(console.error);
    }
  }, []);

  const finishOnboarding = async (config, provider = 'local') => {
    try {
      await fetch('/api/settings/ai-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider })
      });
      await fetch('/api/opalatex/create-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      await fetch('/api/onboarding/complete', { method: 'POST' });
      onComplete();
    } catch (e) {
      console.error(e);
      onComplete(); // proceed anyway to not block user
    }
  };

  const handleClose = async () => {
    try {
      await fetch('/api/onboarding/complete', { method: 'POST' });
    } catch (e) {}
    onComplete();
  };

  const handleInstallOllama = async () => {
    setIsInstalling(true);
    setStep(3); // Mostra o progresso de instalação

    try {
      const r = await fetch('/api/settings/install-ollama', { method: 'POST' });
      const data = await r.json();
      if (!data.success) {
        console.error("Falha ao iniciar instalação do Ollama:", data.error);
        setStep(4); // Exibe fallback para instalação manual
      }
    } catch (e) {
      console.error("Erro ao chamar install-ollama:", e);
      setStep(4);
    }
    setIsInstalling(false);
  };

  const handleOpalaCloud = async () => {
    try {
      const config = {
        project_name: "Projeto Piloto (Opala Cloud)",
        project_path: "~/OpalaTexPilot",
        model: "OpalaTexCloud",
        mode: "plan"
      };
      
      finishOnboarding(config, 'cloud');
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateCloudProject = () => {
    const config = {
      project_name: "Projeto Piloto (API)",
      project_path: "~/OpalaTexPilot",
      model: apiProvider,
      mode: "plan"
    };
    if (apiKey) config.api_key = apiKey;
    if (apiBase) config.api_base = apiBase;
    finishOnboarding(config, 'local');
  };

  const vram = hardware ? parseFloat(hardware.vram_gb) || 0 : 0;
  const isHighEnd = vram >= 8;
  let ollamaModel = "ollama/gemma4:e2b-it-qat";
  if (vram > 32) {
    ollamaModel = "ollama/gemma4:32b";
  } else if (vram > 16) {
    ollamaModel = "ollama/gemma4:26b";
  } else if (vram >= 8) {
    ollamaModel = "ollama/gemma4:12b";
  }

  return (
    <div className="vscode-modal-overlay" style={{ zIndex: 9999, backgroundColor: 'rgba(0,0,0,0.85)' }}>
      <div className="vscode-modal" style={{ maxWidth: '600px', width: '90%', padding: '32px', borderRadius: '12px', border: '1px solid #3c3c3c', backgroundColor: '#1e1e1e', position: 'relative' }}>
        
        <button 
          onClick={handleClose}
          style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0' }}
          title={t('newProjectModal.cancel')}
        >
          <X size={20} />
        </button>
        
        {step === 1 && (
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '16px', color: '#fff' }}>{t('onboarding.welcome')}</h1>
            <p style={{ color: '#ccc', marginBottom: '32px', lineHeight: '1.5' }}>
              {t('onboarding.analyzingMessage')}
            </p>
            {hardware ? (
              <button 
                className="vscode-button" 
                style={{ padding: '12px 24px', fontSize: '16px', borderRadius: '6px' }}
                onClick={() => setStep(2)}
              >
                {t('onboarding.viewRecommendation')}
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#007acc' }}>
                <Loader2 size={24} className="animate-spin" />
                <span>{t('onboarding.analyzingMachine')}</span>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Monitor size={20} />
              {t('onboarding.hardwareDetected', { vram: hardware?.vram_gb, ram: hardware?.ram_gb })}
            </h2>

            {isHighEnd ? (
              <div style={{ backgroundColor: '#1e2e1e', padding: '16px', borderRadius: '8px', border: '1px solid #2e4e2e', marginBottom: '24px' }}>
                <h3 style={{ color: '#4ade80', margin: '0 0 8px 0', fontSize: '16px' }}>{t('onboarding.localTitle')}</h3>
                <p style={{ color: '#ccc', margin: 0, fontSize: '14px', lineHeight: '1.5' }}>
                  {t('onboarding.localMessage')}
                </p>
              </div>
            ) : (
              <div style={{ backgroundColor: '#2e2e1e', padding: '16px', borderRadius: '8px', border: '1px solid #4e4e2e', marginBottom: '24px' }}>
                <h3 style={{ color: '#facc15', margin: '0 0 8px 0', fontSize: '16px' }}>{t('onboarding.cloudTitle')}</h3>
                <p style={{ color: '#ccc', margin: 0, fontSize: '14px', lineHeight: '1.5' }}>
                  {t('onboarding.cloudMessage')}
                </p>
              </div>
            )}

            {FEATURES.enableCloudAccount && (
              !licenseStatus?.key ? (
                <div style={{ backgroundColor: '#2d1e2f', padding: '14px', borderRadius: '8px', border: '1px solid #4a2f4d', marginBottom: '20px' }}>
                  <h3 style={{ color: '#dca4e0', margin: '0 0 6px 0', fontSize: '15px', fontWeight: 'bold' }}>
                    {t('onboarding.openSourceTitle')}
                  </h3>
                  <p style={{ color: '#ccc', margin: '0 0 12px 0', fontSize: '13px', lineHeight: '1.4' }}>
                    {t('onboarding.openSourceDesc')}
                  </p>
                  <button 
                    className="vscode-button"
                    style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '4px', backgroundColor: '#8a2be2', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                    onClick={() => { const lang = i18n.language || 'en'; window.open(`https://opalacoder.com/?lang=${lang}#products`, '_blank'); }}
                  >
                    {t('onboarding.buyCreditsBtn')}
                  </button>
                </div>
              ) : (
                <div style={{ backgroundColor: '#1e282e', padding: '14px', borderRadius: '8px', border: '1px solid #2e3e48', marginBottom: '20px' }}>
                  <h3 style={{ color: '#4fc3f7', margin: '0 0 4px 0', fontSize: '15px', fontWeight: 'bold' }}>
                    {t('onboarding.registeredAccount')}
                  </h3>
                  <p style={{ color: '#ccc', margin: 0, fontSize: '13px', fontFamily: 'monospace' }}>
                    {licenseStatus?.key}
                  </p>
                </div>
              )
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {FEATURES.enableCloudAccount && (
                <button 
                  className="vscode-button" 
                  style={{ padding: '14px', fontSize: '15px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: '#007acc' }}
                  onClick={handleOpalaCloud}
                >
                  <Cloud size={18} />
                  {t('onboarding.useCloudRecommended', 'Use Opala Cloud (Recommended)')}
                </button>
              )}

              <button 
                className="vscode-button" 
                style={{ padding: '14px', fontSize: '15px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: '#3c3c3c' }}
                onClick={() => setStep(3)} // step 3 = Ollama
                disabled={isInstalling}
              >
                <Terminal size={18} />
                {t('onboarding.installOllamaBtn')}
              </button>

              <button 
                className="vscode-button" 
                style={{ padding: '14px', fontSize: '15px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: '#3c3c3c' }}
                onClick={() => setStep(5)} // step 5 = API
              >
                <Settings2 size={18} />
                {t('onboarding.configThirdPartyKey', 'Configure Third-Party API Key')}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#fff' }}>{t('onboarding.preparingOllama')}</h2>
            {ollamaStatus?.installed ? (
              ollamaStatus.is_supported ? (
                <div>
                  <CheckCircle size={48} color="#4ade80" style={{ margin: '0 auto 16px auto' }} />
                  <p style={{ color: '#ccc', marginBottom: '24px' }}>
                    {t('onboarding.ollamaInstalledCompatible', { version: ollamaStatus.version || 'unknown' })}
                  </p>
                  <button className="vscode-button" onClick={() => finishOnboarding({
                    project_name: "Projeto Piloto (Ollama)",
                    project_path: "~/OpalaTexPilot",
                    model: ollamaModel,
                    mode: "plan",
                    api_base: "http://localhost:11434/v1"
                  })}>
                    {t('onboarding.startPilot')}
                  </button>
                </div>
              ) : (
                <div>
                  <h3 style={{ color: '#facc15', marginBottom: '16px' }}>{t('onboarding.updateRequired')}</h3>
                  <p style={{ color: '#ccc', marginBottom: '24px', lineHeight: '1.5' }}>
                    {t('onboarding.updateMessage', { version: ollamaStatus.version })}
                  </p>
                  <button className="vscode-button" onClick={handleInstallOllama} disabled={isInstalling}>
                    {isInstalling ? t('onboarding.installStarted') : t('onboarding.downloadUpdateBtn')}
                  </button>
                  <button className="vscode-button" style={{ marginLeft: '12px', backgroundColor: '#3c3c3c' }} onClick={() => finishOnboarding({
                    project_name: "Projeto Piloto (Ollama)",
                    project_path: "~/OpalaTexPilot",
                    model: ollamaModel,
                    mode: "plan",
                    api_base: "http://localhost:11434/v1"
                  })}>
                    {t('onboarding.ignoreStartBtn')}
                  </button>
                </div>
              )
            ) : (
              <div>
                <p style={{ color: '#ccc', marginBottom: '24px' }}>{t('onboarding.installInstructions')}</p>
                <button className="vscode-button" onClick={handleInstallOllama} disabled={isInstalling}>
                  {isInstalling ? t('onboarding.installStarted') : t('onboarding.downloadInstallBtn')}
                </button>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#fff' }}>{t('onboarding.manualInstallTitle')}</h2>
            <p style={{ color: '#ccc', marginBottom: '16px', lineHeight: '1.5' }}>
              {t('onboarding.manualInstallMessage')}
            </p>
            <div style={{ backgroundColor: '#000', padding: '12px', borderRadius: '6px', border: '1px solid #3c3c3c', marginBottom: '24px', fontFamily: 'monospace', color: '#4ade80' }}>
              curl -fsSL https://ollama.com/install.sh | sh
            </div>
            <button className="vscode-button" onClick={() => finishOnboarding({
              project_name: "Projeto Piloto (Ollama)",
              project_path: "~/OpalaTexPilot",
              model: ollamaModel,
              mode: "plan",
              api_base: "http://localhost:11434/v1"
            })}>
              {t('onboarding.alreadyInstalledBtn')}
            </button>
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#fff' }}>{t('onboarding.configCloudTitle')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label style={{ fontSize: '12px', color: '#ccc' }}>{t('onboarding.recommendedProvider')}</label>
                <select className="vscode-settings-input" value={apiProvider} onChange={(e) => {
                  const val = e.target.value;
                  setApiProvider(val);
                  if (val === 'ollama/gemma4:31b-cloud') {
                    setApiBase('https://ollama.com');
                  } else {
                    setApiBase('');
                  }
                }} style={{ width: '100%' }}>
                  {FEATURES.enableCloudModels && (
                    <option value="ollama/gemma4:31b-cloud">{t('onboarding.providerOllamaCloud')}</option>
                  )}
                  <option value="gemini/gemini-flash-lite-latest">{t('onboarding.providerGemini')}</option>
                  <option value="anthropic/claude-3-5-sonnet-latest">{t('onboarding.providerAnthropic')}</option>
                </select>
              </div>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label style={{ fontSize: '12px', color: '#ccc' }}>{t('onboarding.apiKeyLabel')}</label>
                <input 
                  type="password" 
                  value={apiKey} 
                  onChange={(e) => setApiKey(e.target.value)} 
                  placeholder={t('onboarding.apiKeyPlaceholder')} 
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </div>
              {apiProvider.startsWith('ollama/') && (
                <div className="flex flex-col" style={{ gap: '4px' }}>
                  <label style={{ fontSize: '12px', color: '#ccc' }}>{t('onboarding.apiBaseLabel')}</label>
                  <input 
                    type="text" 
                    value={apiBase} 
                    onChange={(e) => setApiBase(e.target.value)} 
                    placeholder={t('onboarding.apiBasePlaceholder')}
                    className="vscode-settings-input"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="vscode-button" style={{ backgroundColor: '#3c3c3c' }} onClick={() => {
                const config = {
                  project_name: "Projeto Piloto",
                  project_path: "~/OpalaTexPilot",
                  model: apiProvider,
                  mode: "plan"
                };
                if (apiBase) config.api_base = apiBase;
                finishOnboarding(config, 'local');
              }}>
                {t('onboarding.skipKeyBtn')}
              </button>
              <button className="vscode-button" onClick={() => {
                const config = {
                  project_name: "Projeto Piloto (API)",
                  project_path: "~/OpalaTexPilot",
                  model: apiProvider,
                  mode: "plan"
                };
                if (apiKey) config.api_key = apiKey;
                if (apiBase) config.api_base = apiBase;
                finishOnboarding(config, 'local');
              }}>
                {t('onboarding.createPilotBtn')}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
