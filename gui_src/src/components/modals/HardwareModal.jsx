import React, { useState, useEffect } from 'react';

export default function HardwareModal({ onClose }) {
  const [hardware, setHardware] = useState({ ram_gb: '', vram_gb: '', gpu_type: 'unknown' });
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const fetchHardware = async () => {
    try {
      const res = await fetch('/api/hardware');
      if (res.ok) {
        const data = await res.json();
        setHardware(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchHardware();
  }, []);

  const handleDetect = async () => {
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const res = await fetch('/api/hardware/detect', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setHardware(data);
        setSuccessMsg('Hardware inferido com sucesso!');
      } else {
        setErrorMsg('Falha ao inferir hardware. Por favor, insira manualmente.');
      }
    } catch (e) {
      setErrorMsg('Erro de rede ao inferir hardware.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const res = await fetch('/api/hardware/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ram_gb: parseFloat(hardware.ram_gb) || 0,
          vram_gb: parseFloat(hardware.vram_gb) || 0,
          gpu_type: hardware.gpu_type
        })
      });
      if (res.ok) {
        setSuccessMsg('Configurações salvas!');
        setTimeout(onClose, 1000);
      } else {
        setErrorMsg('Falha ao salvar hardware.');
      }
    } catch (e) {
      setErrorMsg('Erro de rede ao salvar hardware.');
    } finally {
      setLoading(false);
    }
  };

  const vram = parseFloat(hardware.vram_gb) || 0;
  let recommendation = "Com base no seu hardware, recomendamos: ";
  if (vram < 4) {
    recommendation += "Modelos de 1.5B a 3B parâmetros (Ex: Qwen 2.5 1.5B, Llama 3.2 3B).";
  } else if (vram < 10) {
    recommendation += "Modelos de 7B a 8B parâmetros (Ex: Llama 3.1 8B, Mistral 7B).";
  } else if (vram < 20) {
    recommendation += "Modelos de 12B a 14B parâmetros (Ex: Qwen 2.5 14B).";
  } else {
    recommendation += "Modelos grandes (Ex: Llama 3 70B quantizado ou Command R).";
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div className="vscode-modal" style={{
        borderRadius: '12px',
        width: '450px', padding: '24px', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: '16px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>💻</span> Configuração de Hardware
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--vscode-text-fg)', cursor: 'pointer', fontSize: '18px' }}>✕</button>
        </div>

        {errorMsg && <div style={{ background: 'rgba(255,0,0,0.1)', color: '#ff6b6b', padding: '10px', borderRadius: '6px', fontSize: '13px' }}>{errorMsg}</div>}
        {successMsg && <div style={{ background: 'rgba(0,255,0,0.1)', color: '#4ade80', padding: '10px', borderRadius: '6px', fontSize: '13px' }}>{successMsg}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: 'var(--vscode-text-fg)' }}>
            Memória RAM do Sistema (GB)
            <input 
              type="number" step="0.1" 
              value={hardware.ram_gb} 
              onChange={e => setHardware({...hardware, ram_gb: e.target.value})}
              className="vscode-settings-input"
              style={{ padding: '8px', borderRadius: '6px' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: 'var(--vscode-text-fg)' }}>
            Memória VRAM da GPU (GB)
            <input 
              type="number" step="0.1" 
              value={hardware.vram_gb} 
              onChange={e => setHardware({...hardware, vram_gb: e.target.value})}
              className="vscode-settings-input"
              style={{ padding: '8px', borderRadius: '6px' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: 'var(--vscode-text-fg)' }}>
            Tipo de GPU
            <select 
              value={hardware.gpu_type}
              onChange={e => setHardware({...hardware, gpu_type: e.target.value})}
              className="vscode-settings-input"
              style={{ padding: '8px', borderRadius: '6px' }}
            >
              <option value="unknown">Desconhecida / Outra</option>
              <option value="nvidia">NVIDIA</option>
              <option value="amd">AMD</option>
              <option value="apple_unified">Apple Silicon (M1/M2/M3/M4)</option>
              <option value="integrated_or_amd">Integrada / Compartilhada</option>
            </select>
          </label>
        </div>

        <div style={{ background: 'var(--vscode-input-bg)', border: '1px solid var(--vscode-border)', borderRadius: '8px', padding: '12px', fontSize: '12px', lineHeight: '1.5', color: 'var(--vscode-text-fg)' }}>
          <strong style={{ color: 'var(--vscode-text-fg)' }}>Recomendação:</strong> {recommendation}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px' }}>
          <button 
            onClick={handleDetect} 
            disabled={loading}
            className="vscode-button"
            style={{ padding: '8px 16px', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}
          >
            {loading ? 'Processando...' : 'Inferir Hardware Automático'}
          </button>
          
          <button 
            onClick={handleSave} 
            disabled={loading}
            className="vscode-button"
            style={{ padding: '8px 16px', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
