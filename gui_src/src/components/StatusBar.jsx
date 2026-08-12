import React from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Bottom status bar (VSCode-style footer).
export default function StatusBar({ activeProject, isAgentRunning }) {
  const { t } = useTranslation();

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
        <span>UTF-8</span>
        <span>LF</span>
        <span>JSON IPC Bridge</span>
      </div>
    </footer>
  );
}
