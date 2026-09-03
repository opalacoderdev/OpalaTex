import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Files, GitBranch, MessageSquare, Settings, Cpu, LayoutTemplate, LayoutGrid, PanelBottom, Terminal, History, Columns2, Store, GraduationCap, Cloud, CloudOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ACTIVITY_BAR_DEFAULT_DENSITY,
  getActivityBarDensity,
  pickActivityBarDensity,
} from '../utils/activityBarDensity';
import { readUiScale } from '../utils/uiScale';
import { layoutShowsEditor } from '../utils/layoutModes';

// Left-side vertical activity bar (VSCode-style icon strip).
export default function ActivityBar({
  activeSidebarTab,
  setActiveSidebarTab,
  isChatVisible,
  setIsChatVisible,
  gitChangesCount,
  onOpenSettings,
  onOpenHardware,
  onOpenAssetStore,
  onOpenCloudSync,
  cloudEnabled,
  onOpenTutorial,
  layoutMode,
  setLayoutMode,
  hasOpenDocument,
  isTerminalCollapsed,
  setIsTerminalCollapsed,
  setActiveBottomTab,
  onOpenProjectSettings,
  hasActiveProject
}) {
  const { t } = useTranslation();
  // Layouts that dock the explorer/source-control sidebar to their left, and so
  // can open one without being switched away from.
  const hasDockedSidebar = layoutShowsEditor(layoutMode);
  // Layouts that do not render the chat at all: the chat-first ones (where the
  // chat *is* the layout and cannot be hidden) and the document layout, which
  // is only the file and its preview. The visibility toggle has nothing to
  // switch in either, so it is disabled rather than silently inert.
  const isChatToggleDisabled = layoutMode === 'chat' || layoutMode === 'chat-bottom' || layoutMode === 'document';

  const barRef = useRef(null);
  const [densityName, setDensityName] = useState(ACTIVITY_BAR_DEFAULT_DENSITY.name);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const density = getActivityBarDensity(densityName);
  // The letter badge on the two settings gears scales with the icon it marks,
  // so at the denser tiers it stays a corner mark instead of covering the gear.
  const badgeStyle = {
    '--activitybar-badge-size': `${Math.max(9, Math.round(density.secondaryIconSize * 0.55))}px`,
    '--activitybar-badge-font': `${Math.max(8, Math.round(density.secondaryIconSize * 0.45))}px`,
  };

  // Which edges still hide a button, so the strip can fade there instead of
  // ending in a half-drawn icon that reads as a rendering glitch.
  const measureFade = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const hidden = bar.scrollHeight - bar.clientHeight;
    const top = hidden > 1 && bar.scrollTop > 1;
    const bottom = hidden > 1 && bar.scrollTop < hidden - 1;
    setFade(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // The bar is stretched by `.vscode-main`, so its own height never depends on
  // the tier we pick — measuring it here cannot oscillate. Button counts come
  // from the DOM so that adding a button keeps the fit calculation honest.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const measure = () => {
      const counts = {
        top: bar.querySelectorAll('.vscode-activitybar-top > *').length,
        bottom: bar.querySelectorAll('.vscode-activitybar-bottom > *').length,
      };
      setDensityName(pickActivityBarDensity(bar.clientHeight, counts).name);
      measureFade();
    };
    measure();
    const stop = [];
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(measure);
      resize.observe(bar);
      stop.push(() => resize.disconnect());
    }
    // The interface scale is a CSS `zoom`, so raising it shrinks the bar in its
    // own CSS pixels while the box it paints keeps the same size on screen —
    // a change ResizeObserver does not report, and the one that hid the last
    // icons in the first place. `--ui-scale` on <html> is the single source of
    // truth for that factor (see utils/uiScale.js), so the bar re-measures when
    // it is rewritten; reading clientHeight then forces the pending layout.
    if (typeof MutationObserver !== 'undefined') {
      let lastScale = readUiScale();
      const zoom = new MutationObserver(() => {
        const scale = readUiScale();
        if (scale === lastScale) return;
        lastScale = scale;
        measure();
      });
      zoom.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      stop.push(() => zoom.disconnect());
    }
    return () => stop.forEach(fn => fn());
  }, [measureFade]);

  // A tier change resizes the content, not the bar, so the fades are recomputed
  // after it lands.
  useEffect(() => { measureFade(); }, [densityName, gitChangesCount, cloudEnabled, measureFade]);

  return (
    <div
      ref={barRef}
      className="vscode-activitybar"
      data-density={density.name}
      data-fade-top={fade.top ? 'true' : 'false'}
      data-fade-bottom={fade.bottom ? 'true' : 'false'}
      onScroll={measureFade}
      style={{
        '--activitybar-padding-y': `${density.paddingY}px`,
        '--activitybar-gap': `${density.gap}px`,
        '--activitybar-btn-padding-y': `${density.buttonPaddingY}px`,
      }}
    >
      <div className="vscode-activitybar-top">
        <button
          onClick={() => setLayoutMode(layoutMode === 'chat' ? 'ide' : 'chat')}
          className={`vscode-activitybar-btn ${layoutMode === 'chat' ? 'active' : ''}`}
          title={layoutMode === 'chat' ? t('activityBar.editMode') : t('activityBar.chatMode')}
        >
          <LayoutTemplate size={density.iconSize} />
        </button>

        <button
          onClick={() => setLayoutMode(layoutMode === 'chat-bottom' ? 'ide' : 'chat-bottom')}
          className={`vscode-activitybar-btn ${layoutMode === 'chat-bottom' ? 'active' : ''}`}
          title={layoutMode === 'chat-bottom' ? t('activityBar.editMode') : t('activityBar.chatBottomMode')}
        >
          <PanelBottom size={density.iconSize} />
        </button>
        <button
          onClick={() => {
            if (!hasDockedSidebar) setLayoutMode('ide');
            setActiveSidebarTab(activeSidebarTab === 'explorer' ? null : 'explorer');
          }}
          className={`vscode-activitybar-btn ${activeSidebarTab === 'explorer' && hasDockedSidebar ? 'active' : ''}`}
          title={t('activityBar.explorer')}
        >
          <Files size={density.iconSize} />
        </button>

        <button
          onClick={() => {
            setLayoutMode('review');
            setActiveSidebarTab(null);
          }}
          className={`vscode-activitybar-btn ${layoutMode === 'review' ? 'active' : ''}`}
          title={t('activityBar.reviewMode')}
        >
          <History size={density.iconSize} />
        </button>


        <button
          onClick={() => {
            if (!hasDockedSidebar) setLayoutMode('ide');
            setActiveSidebarTab(activeSidebarTab === 'git' ? null : 'git');
          }}
          className={`vscode-activitybar-btn ${activeSidebarTab === 'git' && hasDockedSidebar ? 'active' : ''}`}
          title={t('activityBar.sourceControl')}
          style={{ position: 'relative' }}
        >
          <GitBranch size={density.iconSize} />
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
          onClick={() => { if (!isChatToggleDisabled) setIsChatVisible(!isChatVisible); }}
          className={`vscode-activitybar-btn ${isChatVisible || layoutMode === 'chat' || layoutMode === 'chat-bottom' ? 'active' : ''}`}
          title={t('activityBar.opalatexCodes')}
          disabled={isChatToggleDisabled}
          style={{ opacity: isChatToggleDisabled ? 0.5 : 1, cursor: isChatToggleDisabled ? 'not-allowed' : 'pointer' }}
        >
          <MessageSquare size={density.iconSize} />
        </button>

        <button
          onClick={() => setIsTerminalCollapsed(!isTerminalCollapsed)}
          className={`vscode-activitybar-btn ${!isTerminalCollapsed ? 'active' : ''}`}
          title="Alternar Painel Inferior (Terminal)"
        >
          <Terminal size={density.iconSize} />
        </button>

        <button
          onClick={() => {
            if (layoutMode === 'studio') {
              setLayoutMode('ide');
              return;
            }
            // The studio is a four-surface layout, so it opens with all four on
            // screen — except the workspace explorer, which starts retracted
            // because the layout exists to give the document the width.
            setLayoutMode('studio');
            setActiveSidebarTab(null);
            setIsChatVisible(true);
            setIsTerminalCollapsed(false);
            // The layout names that cell the terminal, so it opens on the
            // terminal rather than on whichever tab was last read there.
            setActiveBottomTab('terminal');
          }}
          className={`vscode-activitybar-btn ${layoutMode === 'studio' ? 'active' : ''}`}
          title={layoutMode === 'studio' ? t('activityBar.editMode') : t('activityBar.studioMode')}
        >
          <LayoutGrid size={density.iconSize} />
        </button>

        <button
          onClick={() => {
            if (layoutMode === 'document') {
              setLayoutMode('ide');
              return;
            }
            // Two panes and nothing else: the open document and its preview.
            // The explorer starts retracted for the same reason the studio
            // retracts it — the layout exists to give the document the width,
            // and it can be reopened from this bar without leaving the layout.
            // With no document open there is nothing to give the width to, and
            // the editor's empty state points at the file tree, so the layout
            // opens on the explorer instead of on a closed sidebar.
            setLayoutMode('document');
            setActiveSidebarTab(hasOpenDocument ? null : 'explorer');
          }}
          className={`vscode-activitybar-btn ${layoutMode === 'document' ? 'active' : ''}`}
          title={layoutMode === 'document' ? t('activityBar.editMode') : t('activityBar.documentMode')}
        >
          <Columns2 size={density.iconSize} />
        </button>
      </div>

      <div className="vscode-activitybar-bottom">
        <button
          onClick={onOpenTutorial}
          className="vscode-activitybar-btn"
          title={t('activityBar.tutorial', 'Tutorial')}
        >
          <GraduationCap size={density.secondaryIconSize} />
        </button>

        <button
          onClick={onOpenAssetStore}
          className="vscode-activitybar-btn"
          title={t('activityBar.assetStore', 'Asset Store')}
        >
          <Store size={density.secondaryIconSize} />
        </button>

        <button
          onClick={onOpenCloudSync}
          className="vscode-activitybar-btn"
          title={cloudEnabled
            ? t('activityBar.cloudSyncOn', 'Cloud sync (on)')
            : t('activityBar.cloudSync', 'Cloud sync')}
        >
          {cloudEnabled ? <Cloud size={density.secondaryIconSize} /> : <CloudOff size={density.secondaryIconSize} />}
        </button>

        <button
          onClick={onOpenHardware}
          className="vscode-activitybar-btn"
          title={t('activityBar.hardware', 'Hardware')}
        >
          <Cpu size={density.secondaryIconSize} />
        </button>

        <button
          onClick={(e) => { if (hasActiveProject) onOpenProjectSettings?.(e); }}
          className="vscode-activitybar-btn"
          title={hasActiveProject
            ? t('activityBar.projectSettings', 'Project settings')
            : t('activityBar.projectSettingsDisabled', 'Open a project to change its settings')}
          disabled={!hasActiveProject}
          style={{ opacity: hasActiveProject ? 1 : 0.5, cursor: hasActiveProject ? 'pointer' : 'not-allowed' }}
        >
          <span className="vscode-activitybar-icon" style={badgeStyle}>
            <Settings size={density.secondaryIconSize} />
            <span className="vscode-activitybar-icon-badge" aria-hidden="true">
              {t('activityBar.projectSettingsBadge', 'P')}
            </span>
          </span>
        </button>

        <button
          onClick={onOpenSettings}
          className="vscode-activitybar-btn"
          title={t('activityBar.editorSettings', 'Editor settings')}
        >
          <span className="vscode-activitybar-icon" style={badgeStyle}>
            <Settings size={density.secondaryIconSize} />
            <span className="vscode-activitybar-icon-badge" aria-hidden="true">
              {t('activityBar.editorSettingsBadge', 'E')}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
