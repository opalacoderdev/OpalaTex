import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Plus, Minus, RotateCcw, GitCommit, History, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function buildStatusMeta(t) {
  return {
    M:  { label: 'M', color: '#e2b52b', title: t('gitSidebar.statusModified') },
    A:  { label: 'A', color: '#73c991', title: t('gitSidebar.statusAdded') },
    D:  { label: 'D', color: '#f48771', title: t('gitSidebar.statusDeleted') },
    R:  { label: 'R', color: '#9cdcfe', title: t('gitSidebar.statusRenamed') },
    C:  { label: 'C', color: '#9cdcfe', title: t('gitSidebar.statusCopied') },
    '??': { label: 'U', color: '#73c991', title: t('gitSidebar.statusUntracked') },
  };
}

function DiffViewer({ diff }) {
  const { t } = useTranslation();
  if (!diff || !diff.trim()) return (
    <div style={{ padding: '8px', fontSize: '11px', color: '#808080', fontStyle: 'italic' }}>{t('gitSidebar.noDiff')}</div>
  );
  return (
    <div style={{ fontFamily: 'monospace', fontSize: '11px', overflowX: 'auto', background: 'var(--vscode-input-bg)', borderRadius: '4px', padding: '6px', border: '1px solid var(--vscode-border)' }}>
      {diff.split('\n').map((line, i) => {
        let bg = 'transparent';
        let color = '#cccccc';
        if (line.startsWith('+') && !line.startsWith('+++')) { bg = 'rgba(115,201,145,0.12)'; color = '#73c991'; }
        else if (line.startsWith('-') && !line.startsWith('---')) { bg = 'rgba(244,135,113,0.12)'; color = '#f48771'; }
        else if (line.startsWith('@@')) { color = '#9cdcfe'; }
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) { color = '#808080'; }
        return (
          <div key={i} style={{ background: bg, color, whiteSpace: 'pre', lineHeight: '1.5' }}>{line || ' '}</div>
        );
      })}
    </div>
  );
}

function FileRow({ file, projectPath, onStage, onUnstage, onDiscard, onToggleDiff, expandedDiff, diff, loadingDiff }) {
  const { t } = useTranslation();
  const statusMeta = buildStatusMeta(t);
  const meta = statusMeta[file.status] || { label: file.status || '?', color: '#808080', title: file.status };
  const isStaged = file.staged;
  return (
    <div style={{ borderRadius: '3px', marginBottom: '2px', background: 'rgba(255,255,255,0.02)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', padding: '3px 4px', cursor: 'pointer' }}
        onClick={() => onToggleDiff(file.path)}
        title={meta.title}
      >
        <span style={{ color: '#808080', width: '14px', flexShrink: 0 }}>
          {expandedDiff ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="truncate" title={file.path} style={{ color: '#cccccc', flex: 1 }}>{file.path}</span>
        <span style={{ fontWeight: 'bold', color: meta.color, fontSize: '11px', minWidth: '14px', textAlign: 'center' }}>
          {meta.label}
        </span>
        {/* action buttons */}
        <span style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
          {!isStaged ? (
            <button
              title={t('gitSidebar.addToStage')}
              onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#73c991', padding: '1px' }}
            >
              <Plus size={12} />
            </button>
          ) : (
            <button
              title={t('gitSidebar.removeFromStage')}
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e2b52b', padding: '1px' }}
            >
              <Minus size={12} />
            </button>
          )}
          <button
            title={file.status === '??' ? t('gitSidebar.discardUntracked') : t('gitSidebar.discardChanges')}
            onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f48771', padding: '1px' }}
          >
            <RotateCcw size={12} />
          </button>
        </span>
      </div>
      {expandedDiff && (
        <div style={{ padding: '0 4px 6px 24px' }}>
          {loadingDiff ? (
            <div style={{ fontSize: '11px', color: '#808080' }}>{t('gitSidebar.loadingDiff')}</div>
          ) : (
            <DiffViewer diff={diff} />
          )}
        </div>
      )}
    </div>
  );
}

export default function GitSidebar({
  activeProject,
  gitChanges,
  fetchGitStatus,
  commitMessage,
  setCommitMessage,
  isCommitting,
  handleGitCommit,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  useShadowGit,
  setUseShadowGit,
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('changes'); // 'changes' | 'log'
  const [expandedDiffs, setExpandedDiffs] = useState({});
  const [diffs, setDiffs] = useState({});
  const [loadingDiffs, setLoadingDiffs] = useState({});
  const [commits, setCommits] = useState([]);
  const [loadingLog, setLoadingLog] = useState(false);

  const projectPath = activeProject?.project_path;

  const fetchLog = useCallback(async () => {
    if (!projectPath) return;
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/git/log?projectPath=${encodeURIComponent(projectPath)}&limit=30&shadow=${useShadowGit}`);
      if (res.ok) { const d = await res.json(); setCommits(d.commits || []); }
    } catch { /* ignore */ }
    finally { setLoadingLog(false); }
  }, [projectPath]);

  useEffect(() => {
    if (activeTab === 'log' && projectPath) fetchLog();
  }, [activeTab, projectPath, fetchLog, useShadowGit]);

  useEffect(() => {
    fetchGitStatus();
  }, [useShadowGit]);

  useEffect(() => {
    setExpandedDiffs({});
    setDiffs({});
  }, [projectPath]);

  const toggleDiff = async (filePath) => {
    const next = !expandedDiffs[filePath];
    setExpandedDiffs(prev => ({ ...prev, [filePath]: next }));
    if (next && !diffs[filePath]) {
      setLoadingDiffs(prev => ({ ...prev, [filePath]: true }));
      try {
        const res = await fetch(`/api/git/diff?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}&shadow=${useShadowGit}`);
        if (res.ok) { const d = await res.json(); setDiffs(prev => ({ ...prev, [filePath]: d.diff || '' })); }
      } catch { /* ignore */ }
      finally { setLoadingDiffs(prev => ({ ...prev, [filePath]: false })); }
    }
  };

  const refreshDiff = (filePath) => {
    setDiffs(prev => { const n = { ...prev }; delete n[filePath]; return n; });
  };

  const handleStage = async (filePath) => {
    await onStageFile(filePath);
    refreshDiff(filePath);
  };

  const handleUnstage = async (filePath) => {
    await onUnstageFile(filePath);
    refreshDiff(filePath);
  };

  const handleDiscard = async (filePath) => {
    await onDiscardFile(filePath);
    setExpandedDiffs(prev => { const n = { ...prev }; delete n[filePath]; return n; });
    refreshDiff(filePath);
  };

  const handleStageAll = async () => {
    if (!projectPath) return;
    for (const f of gitChanges) {
      if (!f.staged) {
        await fetch('/api/git/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath, filePath: f.path, action: 'stage', shadow: useShadowGit }) });
      }
    }
    setDiffs({});
    fetchGitStatus();
  };

  const tabStyle = (tab) => ({
    flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0',
    fontSize: '11px', fontWeight: activeTab === tab ? 'bold' : 'normal',
    color: activeTab === tab ? '#cccccc' : '#808080',
    borderBottom: activeTab === tab ? '2px solid #007acc' : '2px solid transparent',
  });

  if (!activeProject) return (
    <div className="vscode-sidebar-content" style={{ padding: '12px' }}>
      <div className="vscode-sidebar-title">{t('gitSidebar.header')}</div>
      <div style={{ fontSize: '12px', color: '#808080', fontStyle: 'italic', marginTop: '12px' }}>
        {t('gitSidebar.selectProjectForVcs')}
      </div>
    </div>
  );

  return (
    <div className="vscode-sidebar-content" style={{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="vscode-sidebar-title" style={{ margin: 0 }}>{t('gitSidebar.header')}</div>
        <button
          onClick={() => { fetchGitStatus(); if (activeTab === 'log') fetchLog(); }}
          title={t('gitSidebar.refresh')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#808080', padding: '2px' }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <select
          value={useShadowGit ? "shadow" : "user"}
          onChange={(e) => {
            setUseShadowGit(e.target.value === "shadow");
          }}
          className="vscode-settings-input"
          style={{ width: '100%', padding: '4px', borderRadius: '3px', fontSize: '11px' }}
        >
          <option value="user">👤 Meu Repositório (Git)</option>
          <option value="shadow">🤖 Histórico do Agente (Shadow)</option>
        </select>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-border)', padding: '0 12px' }}>
        <button style={tabStyle('changes')} onClick={() => setActiveTab('changes')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
            <GitBranch size={11} /> {t('gitSidebar.changesTab')} {gitChanges.length > 0 && `(${gitChanges.length})`}
          </span>
        </button>
        <button style={tabStyle('log')} onClick={() => setActiveTab('log')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
            <History size={11} /> {t('gitSidebar.historyTab')}
          </span>
        </button>
      </div>

      {/* Tab: Changes */}
      {activeTab === 'changes' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px', gap: '12px' }}>
          {/* Commit form */}
          <form onSubmit={handleGitCommit} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input
              type="text"
              placeholder={t('gitSidebar.commitPlaceholder')}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              required
              style={{ width: '100%', fontSize: '12px', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="vscode-button"
                onClick={handleStageAll}
                title={t('gitSidebar.stageAll')}
                style={{ flex: '0 0 auto', fontSize: '11px', padding: '4px 8px' }}
                disabled={gitChanges.length === 0}
              >
                +All
              </button>
              <button
                type="submit"
                className="vscode-button"
                disabled={isCommitting || !commitMessage.trim()}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
              >
                <GitCommit size={12} />
                {isCommitting ? t('gitSidebar.committing') : t('gitSidebar.commit')}
              </button>
            </div>
          </form>

          {/* File list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {gitChanges.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#808080', fontStyle: 'italic' }}>{t('gitSidebar.noChanges')}</div>
            ) : (
              <>
                <div className="vscode-sidebar-section-title" style={{ marginBottom: '6px', padding: 0 }}>
                  {t('gitSidebar.modifications', { count: gitChanges.length })}
                </div>
                {gitChanges.map((file, i) => (
                  <FileRow
                    key={i}
                    file={file}
                    projectPath={projectPath}
                    onStage={handleStage}
                    onUnstage={handleUnstage}
                    onDiscard={handleDiscard}
                    onToggleDiff={toggleDiff}
                    expandedDiff={!!expandedDiffs[file.path]}
                    diff={diffs[file.path]}
                    loadingDiff={!!loadingDiffs[file.path]}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab: Log */}
      {activeTab === 'log' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {loadingLog ? (
            <div style={{ fontSize: '12px', color: '#808080' }}>{t('gitSidebar.loadingHistory')}</div>
          ) : commits.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#808080', fontStyle: 'italic' }}>{t('gitSidebar.noCommits')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {commits.map((c, i) => (
                <div key={i} style={{ padding: '6px 8px', borderRadius: '3px', background: 'rgba(255,255,255,0.02)', fontSize: '11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                    <span style={{ fontFamily: 'monospace', color: '#9cdcfe', flexShrink: 0 }}>{c.short}</span>
                    <span style={{ color: '#cccccc', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.message}>
                      {c.message}
                    </span>
                  </div>
                  <div style={{ color: '#808080', display: 'flex', gap: '8px' }}>
                    <span>{c.author}</span>
                    <span>{c.date}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
