import React from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Bottom status bar (VSCode-style footer).
export default function StatusBar({ activeProject, isAgentRunning, licenseData, onOpenLicense }) {
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
          }
          fetch('/api/settings/token-balance')
            .then(r => r.ok ? r.json() : null)
            .then(bal => {
              if (bal && bal.balance !== undefined) setTokenBalance(bal.balance);
            }).catch(() => {});
        }).catch(() => {});
    };
    checkBalance();
    const interval = setInterval(checkBalance, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleRechargeClick = async (e) => {
    e.preventDefault();
    if (!licenseData?.key) {
      alert("Nenhuma conta Cloud registrada. Compre créditos para receber sua chave de registro.");
      window.open('https://opalacoder.com/#products', '_blank');
      return;
    }
    
    try {
      const res = await fetch('https://opalacoder.com/api/create-recharge-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: licenseData.key })
      });
      const text = await res.text();
      let data;
      try {
          data = JSON.parse(text);
      } catch (e) {
          alert(`Erro no parse da resposta: ${text.substring(0, 50)}`);
          window.open('https://opalacoder.com/#products', '_blank');
          return;
      }

      if (data.token) {
        window.open(`https://opalacoder.com/?rechargeToken=${data.token}`, '_blank');
      } else {
        alert(`Falha ao gerar sessão de recarga. Status: ${res.status}. Resposta: ${JSON.stringify(data)}`);
        window.open('https://opalacoder.com/#products', '_blank');
      }
    } catch (err) {
      alert(`Erro de rede ao contactar a API: ${err.message}`);
      window.open('https://opalacoder.com/#products', '_blank');
    }
  };

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
        
        {/* Cloud registration badge */}
        {licenseData?.status === 'REGISTERED' && (
          <div 
            onClick={onOpenLicense}
            className="flex items-center cursor-pointer hover:bg-white/10 px-2 py-0.5 rounded transition-colors" 
            style={{ gap: '4px', backgroundColor: 'rgba(255, 165, 0, 0.2)', border: '1px solid rgba(255,165,0,0.5)', color: '#ffb84d' }}
            title="Conta registrada para os serviços do OpalaWebPage"
          >
            <span style={{ fontWeight: 'bold', fontSize: '11px' }}>
              OPALA CLOUD REGISTRADO
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center" style={{ gap: '12px' }}>
        <button 
          onClick={handleRechargeClick}
          className="flex items-center underline cursor-pointer"
          style={{ gap: '4px', color: '#ffffff', fontSize: '12px', fontWeight: 'bold', padding: '2px 6px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '4px', border: 'none' }}
          title={t('statusBar.buyCreditsTitle', 'Comprar mais créditos de IA ou Assinatura')}
        >
          {t('statusBar.buyCredits', '☁️ Comprar Créditos')}
        </button>
        
        <span style={{ color: '#a3be8c', fontWeight: 'bold' }}>
          {t('statusBar.balance', { amount: tokenBalance !== null ? (tokenBalance >= 1000000 ? (tokenBalance/1000000).toFixed(1).replace('.0','') + 'M' : tokenBalance >= 1000 ? (tokenBalance/1000).toFixed(1).replace('.0','') + 'K' : tokenBalance.toLocaleString()) : '...' })}
        </span>
        
        <span>UTF-8</span>
        <span>LF</span>
        <span>JSON IPC Bridge</span>
      </div>
    </footer>
  );
}
