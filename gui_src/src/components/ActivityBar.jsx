import React from 'react';
import { Files, GitBranch, MessageSquare, Settings, Cpu, LayoutTemplate, Terminal, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Left-side vertical activity bar (VSCode-style icon strip).
export default function ActivityBar({
  activeSidebarTab,
  setActiveSidebarTab,
  isChatVisible,
  setIsChatVisible,
  gitChangesCount,
  onOpenSettings,
  onOpenHardware,
  layoutMode,
  setLayoutMode,
  isTerminalCollapsed,
  setIsTerminalCollapsed
}) {
  const { t } = useTranslation();

  return (
    <div className="vscode-activitybar">
      <div className="vscode-activitybar-top">
        <button
          onClick={() => setLayoutMode(layoutMode === 'chat' ? 'ide' : 'chat')}
          className={`vscode-activitybar-btn ${layoutMode === 'chat' ? 'active' : ''}`}
          title={layoutMode === 'chat' ? t('activityBar.editMode') : t('activityBar.chatMode')}
        >
          <LayoutTemplate size={22} />
        </button>

        <button
          onClick={() => {
            setLayoutMode('ide');
            setActiveSidebarTab(activeSidebarTab === 'explorer' ? null : 'explorer');
          }}
          className={`vscode-activitybar-btn ${activeSidebarTab === 'explorer' && layoutMode === 'ide' ? 'active' : ''}`}
          title={t('activityBar.explorer')}
        >
          <Files size={22} />
        </button>

        <button
          onClick={() => {
            setLayoutMode('review');
            setActiveSidebarTab(null);
          }}
          className={`vscode-activitybar-btn ${layoutMode === 'review' ? 'active' : ''}`}
          title={t('activityBar.reviewMode')}
        >
          <History size={22} />
        </button>

        <button
          onClick={() => {
            setLayoutMode('ide');
            setActiveSidebarTab(activeSidebarTab === 'git' ? null : 'git');
          }}
          className={`vscode-activitybar-btn ${activeSidebarTab === 'git' && layoutMode === 'ide' ? 'active' : ''}`}
          title={t('activityBar.sourceControl')}
          style={{ position: 'relative' }}
        >
          <GitBranch size={22} />
          {gitChangesCount > 0 && (
            <span style={{
              position: 'absolute',
              top: '4px',
              right: '4px',
              background: '#007acc',
              color: '#ffffff',
              borderRadius: '50%',
              width: '16px',
              height: '16px',
              fontSize: '9px',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 4px rgba(0,0,0,0.5)',
            }}>
              {gitChangesCount}
            </span>
          )}
        </button>

        <button
          onClick={() => { if (layoutMode !== 'chat') setIsChatVisible(!isChatVisible); }}
          className={`vscode-activitybar-btn ${isChatVisible || layoutMode === 'chat' ? 'active' : ''}`}
          title={t('activityBar.opalatexCodes')}
          disabled={layoutMode === 'chat'}
          style={{ opacity: layoutMode === 'chat' ? 0.5 : 1, cursor: layoutMode === 'chat' ? 'not-allowed' : 'pointer' }}
        >
          <MessageSquare size={22} />
        </button>

        <button
          onClick={() => setIsTerminalCollapsed(!isTerminalCollapsed)}
          className={`vscode-activitybar-btn ${!isTerminalCollapsed ? 'active' : ''}`}
          title="Alternar Painel Inferior (Terminal)"
        >
          <Terminal size={22} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <button
          onClick={onOpenHardware}
          className="vscode-activitybar-btn"
          title={t('activityBar.hardware', 'Hardware')}
        >
          <Cpu size={20} />
        </button>

        <button
          onClick={onOpenSettings}
          className="vscode-activitybar-btn"
          title={t('activityBar.settings')}
        >
          <Settings size={20} />
        </button>
      </div>
    </div>
  );
}
