import React, { useState } from 'react';

export default function LicenseModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleActivate = async () => {
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccess(data.message || 'Cloud account registered!');
        setTimeout(() => {
          onClose(); // Needs to trigger a reload or refresh of license status
        }, 1500);
      } else {
        setError(data.message || data.error || 'Invalid registration key.');
      }
    } catch (err) {
      setError('Connection error. Could not activate.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(5px)',
      zIndex: 10000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px'
    }}>
      <div style={{
        backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
        border: '1px solid var(--vscode-panel-border, #333)',
        borderRadius: '8px',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        width: '100%',
        maxWidth: '450px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'var(--vscode-editor-foreground, #cccccc)'
      }}>
        <div style={{
          padding: '16px',
          borderBottom: '1px solid var(--vscode-panel-border, #333)',
          backgroundColor: 'var(--vscode-sideBar-background, #252526)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--vscode-editor-foreground, #e8e8e8)' }}>
            Register Opala Cloud
          </h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#858585', cursor: 'pointer', fontSize: '18px'
          }}>
            &times;
          </button>
        </div>
        
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ margin: 0, fontSize: '14px', lineHeight: '1.5', color: '#cccccc' }}>
            Register a valid key to use OpalaWebPage cloud credits. OpalaTex itself is open-source and remains fully available without registration.
          </p>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '12px', color: '#858585', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Cloud Registration Key
            </label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="OPALA-XXXX-XXXX-XXXX"
              autoFocus
              style={{
                width: '100%',
                backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                color: 'var(--vscode-input-foreground, #cccccc)',
                border: '1px solid var(--vscode-input-border, #444)',
                borderRadius: '4px',
                padding: '10px 12px',
                fontSize: '14px',
                fontFamily: 'monospace',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {error && <div style={{ color: '#f48771', fontSize: '13px', padding: '10px', backgroundColor: 'rgba(244,135,113,0.1)', borderRadius: '4px' }}>{error}</div>}
          {success && <div style={{ color: '#89d185', fontSize: '13px', padding: '10px', backgroundColor: 'rgba(137,209,133,0.1)', borderRadius: '4px' }}>{success}</div>}
        </div>
        
        <div style={{
          padding: '16px',
          backgroundColor: 'var(--vscode-sideBar-background, #252526)',
          borderTop: '1px solid var(--vscode-panel-border, #333)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '12px'
        }}>
          <button onClick={onClose} style={{
            padding: '8px 16px',
            fontSize: '14px',
            backgroundColor: 'transparent',
            color: '#cccccc',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px'
          }}>
            Cancel
          </button>
          <button 
            onClick={handleActivate}
            disabled={!key.trim() || isLoading}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              backgroundColor: (!key.trim() || isLoading) ? '#4d4d4d' : 'var(--vscode-button-background, #0e639c)',
              color: 'var(--vscode-button-foreground, #ffffff)',
              border: 'none',
              borderRadius: '4px',
              cursor: (!key.trim() || isLoading) ? 'not-allowed' : 'pointer',
              opacity: (!key.trim() || isLoading) ? 0.7 : 1
            }}
          >
            {isLoading ? 'Registering...' : 'Register Cloud Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
