import React from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Bottom status bar (VSCode-style footer).
export default function StatusBar({ activeProject, isAgentRunning }) {
  const { t } = useTranslation();

  const [tokenBalance, setTokenBalance] = React.useState(null);
  const [aiProvider, setAiProvider] = React.useState('local');

  React.useEffect(() => {
    // Check AI Provider and Token Balance every 10 seconds if cloud is active
    const checkBalance = () => {
      fetch('/api/settings/ai-provider')
        .then(r => r.ok ? r.json() : null)
        .then(cfg => {
          if (cfg?.provider) {
            setAiProvider(cfg.provider);
            if (cfg.provider === 'cloud') {
              fetch('/api/settings/token-balance')
                .then(r => r.ok ? r.json() : null)
                .then(bal => {
                  if (bal && bal.balance !== undefined) setTokenBalance(bal.balance);
                }).catch(() => {});
            }
          }
        }).catch(() => {});
    };
    checkBalance();
    const interval = setInterval(checkBalance, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <footer className="vscode-statusbar">
      <div className="flex items-center" style={{ gap: '16px' }}>
        <div className="flex items-center" style={{ gap: '6px' }}>
          <Info size={11} />
          <span style={{ fontWeight: 'bold' }}>
            {activeProject
              ? t('statusBar.workspace', { name: activeProject.project_name || activeProject.name })
              : t('statusBar.noWorkspace')}
          </span>
        </div>
        {isAgentRunning && (
          <span className="flex items-center" style={{ gap: '6px' }}>
            <span style={{ width: '6px', height: '6px', backgroundColor: '#ffffff', borderRadius: '50%', display: 'inline-block' }} />
            <span style={{ fontWeight: 'bold' }}>{t('statusBar.agentRunning')}</span>
          </span>
        )}
      </div>

      <div className="flex items-center" style={{ gap: '12px' }}>
        {aiProvider === 'cloud' && (
          <span style={{ color: '#a3be8c', fontWeight: 'bold' }}>
            ☁️ Créditos: {tokenBalance !== null ? tokenBalance.toLocaleString('pt-BR') : '...'}
          </span>
        )}
        <span>UTF-8</span>
        <span>LF</span>
        <span>JSON IPC Bridge</span>
      </div>
    </footer>
  );
}
