import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { X, Check } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

export default function InteractiveTerminalModal({ request, onConfirm, activeProject }) {
  const { t } = useTranslation();
  const terminalRef = useRef(null);
  const eventSourceRef = useRef(null);
  const termInstanceRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    if (!request || !request.term_id || !request.command || !activeProject) return;

    // Only start once per request
    if (hasStarted) return;
    setHasStarted(true);

    const term_id = request.term_id;
    const command = request.command;
    const projectPath = activeProject.project_path;

    // Start temp terminal backend session
    fetch('/api/terminal/temp/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id, command, projectPath }),
    }).then(r => r.json()).then(res => {
      if (res.ok) {
        setIsReady(true);
      } else {
        console.error('Failed to start temp terminal', res.error);
      }
    }).catch(err => console.error('API Error starting temp terminal', err));
    
  }, [request, activeProject, hasStarted]);

  useEffect(() => {
    if (!isReady || !terminalRef.current || !request) return;

    const term_id = request.term_id;
    const projectPath = activeProject.project_path;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: { background: '#1e1e2e', foreground: '#cccccc' },
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    terminalRef.current.innerHTML = '';
    term.open(terminalRef.current);
    try { fitAddon.fit(); } catch (e) { }
    termInstanceRef.current = term;

    // Connect SSE
    const evs = new EventSource(`/api/terminal/stream?term_id=${term_id}&projectPath=${encodeURIComponent(projectPath)}`);
    eventSourceRef.current = evs;

    evs.onmessage = (event) => {
      try {
        const raw = atob(event.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        term.write(bytes);
      } catch (err) {}
    };

    term.onData((data) => {
      fetch('/api/terminal/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term_id, action: 'input', text: data, projectPath }),
      }).catch(() => {});
    });

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddon) {
        try {
          fitAddon.fit();
          const { cols, rows } = term;
          fetch('/api/terminal/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ term_id, action: 'resize', cols, rows, projectPath }),
          }).catch(() => {});
        } catch (e) {}
      }
    });
    resizeObserver.observe(terminalRef.current);

    setTimeout(() => term.focus(), 100);

    return () => {
      resizeObserver.disconnect();
      if (evs) evs.close();
      term.dispose();
    };
  }, [isReady, request, activeProject]);

  if (!request) return null;

  const handleFinish = (result) => {
    if (request.term_id) {
      fetch('/api/terminal/temp/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term_id: request.term_id }),
      }).catch(() => {});
    }
    onConfirm(result);
  };

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
        padding: '16px',
        width: '80%',
        maxWidth: '800px',
        height: '60vh',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>💻</span>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#a0a0c0', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Terminal Interativo: {request.command}
            </span>
          </div>
          <button
            onClick={() => handleFinish('cancel')}
            style={{ background: 'transparent', border: 'none', color: '#a0a0c0', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Terminal Container */}
        <div 
          ref={terminalRef} 
          style={{ flex: 1, background: '#1e1e2e', borderRadius: '8px', overflow: 'hidden', padding: '8px', border: '1px solid #3c3c5c' }} 
        />

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', gap: '12px' }}>
          <button
            onClick={() => handleFinish('yes')}
            style={{
              padding: '8px 24px', borderRadius: '8px', border: 'none',
              background: 'linear-gradient(135deg, #007acc, #0062a3)',
              color: '#fff', cursor: 'pointer',
              fontSize: '13px', fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: '8px',
              boxShadow: '0 4px 16px rgba(0,122,204,0.35)',
            }}
          >
            <Check size={16} /> Concluir
          </button>
        </div>
      </div>
    </div>
  );
}
