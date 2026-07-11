import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function DeleteProjectModal({ projectToDelete, onCancel, onConfirm }) {
  const { t } = useTranslation();
  const [deleteDir, setDeleteDir] = useState(false);

  if (!projectToDelete) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
      animation: 'fadeIn 0.15s ease',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1e1e2e 0%, #252537 100%)',
        border: '1px solid #3c3c5c',
        borderRadius: '12px',
        padding: '28px 32px',
        maxWidth: '420px',
        width: '90%',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <span style={{ fontSize: '22px' }}>⚠️</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#a0a0c0', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Remover Projeto
          </span>
        </div>

        <p style={{ fontSize: '14px', color: '#e0e0f0', lineHeight: 1.6, marginBottom: '16px', margin: '0 0 16px 0' }}>
          Tem certeza que deseja remover o projeto <strong>'{projectToDelete}'</strong>?
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#a0a0c0', marginBottom: '24px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={deleteDir}
            onChange={(e) => setDeleteDir(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          Deletar também o diretório associado ao projeto
        </label>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => { setDeleteDir(false); onCancel(); }}
            style={{
              padding: '8px 20px', borderRadius: '8px', border: '1px solid #4c4c6c',
              background: 'transparent', color: '#a0a0c0', cursor: 'pointer',
              fontSize: '13px', fontWeight: 600, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.target.style.background = '#2c2c3c'; e.target.style.color = '#e0e0f0'; }}
            onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = '#a0a0c0'; }}
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              onConfirm(deleteDir);
              setDeleteDir(false);
            }}
            style={{
              padding: '8px 24px', borderRadius: '8px', border: 'none',
              background: 'linear-gradient(135deg, #cc3333, #a30000)',
              color: '#fff', cursor: 'pointer',
              fontSize: '13px', fontWeight: 700,
              boxShadow: '0 4px 16px rgba(204,51,51,0.35)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.target.style.background = 'linear-gradient(135deg, #f03030, #cc3333)'; }}
            onMouseLeave={e => { e.target.style.background = 'linear-gradient(135deg, #cc3333, #a30000)'; }}
          >
            Remover
          </button>
        </div>
      </div>
    </div>
  );
}
