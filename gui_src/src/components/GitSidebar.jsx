import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Plus, Minus, RotateCcw, GitCommit, History, GitBranch, FolderOpen, X, Eye } from 'lucide-react';
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

function DiffViewer({ diff, wrapLines = false }) {
  const { t } = useTranslation();
  if (!diff || !diff.trim()) return (
    <div style={{ padding: '8px', fontSize: '11px', color: '#808080', fontStyle: 'italic' }}>{t('gitSidebar.noDiff')}</div>
  );
  const lineStyle = {
    lineHeight: '1.5',
    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
    overflowWrap: wrapLines ? 'anywhere' : 'normal',
    wordBreak: wrapLines ? 'break-word' : 'normal',
  };
  return (
    <div style={{ fontFamily: 'monospace', fontSize: '11px', overflowX: wrapLines ? 'hidden' : 'auto', background: 'var(--vscode-input-bg)', borderRadius: '4px', padding: '6px', border: '1px solid var(--vscode-border)' }}>
      {diff.split('\n').map((line, i) => {
        let bg = 'transparent';
        let color = '#cccccc';
        if (line.startsWith('+') && !line.startsWith('+++')) { bg = 'rgba(115,201,145,0.12)'; color = '#73c991'; }
        else if (line.startsWith('-') && !line.startsWith('---')) { bg = 'rgba(244,135,113,0.12)'; color = '#f48771'; }
        else if (line.startsWith('@@')) { color = '#9cdcfe'; }
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) { color = '#808080'; }
        return (
          <div key={i} style={{ ...lineStyle, background: bg, color }}>{line || ' '}</div>
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
    <div className="git-file-row">
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', padding: '3px 4px', cursor: 'pointer' }}
        onClick={() => onToggleDiff(file.path)}
        title={meta.title}
      >
        <span style={{ color: 'var(--vscode-descriptionForeground)', width: '14px', flexShrink: 0 }}>
          {expandedDiff ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="truncate" title={file.path} style={{ color: 'var(--vscode-text-fg)', flex: 1 }}>{file.path}</span>
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
  gitRootPath,
  onPickGitRoot,
  onClearGitRoot,
  reviewMode = false,
  onAfterRestore,
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('changes'); // 'changes' | 'log'
  const [expandedDiffs, setExpandedDiffs] = useState({});
  const [diffs, setDiffs] = useState({});
  const [loadingDiffs, setLoadingDiffs] = useState({});
  const [expandedCommitDiffs, setExpandedCommitDiffs] = useState({});
  const [commitDiffs, setCommitDiffs] = useState({});
  const [loadingCommitDiffs, setLoadingCommitDiffs] = useState({});
  const [restoringCommit, setRestoringCommit] = useState('');
  const [commits, setCommits] = useState([]);
  const [loadingLog, setLoadingLog] = useState(false);

  const projectPath = activeProject?.project_path;
  const effectiveUseShadowGit = reviewMode ? true : useShadowGit;
  const effectiveGitRoot = gitRootPath || projectPath;
  const gitQuery = useCallback((extra = {}) => {
    const params = new URLSearchParams({
      projectPath,
      shadow: String(effectiveUseShadowGit),
      ...extra,
    });
    if (!effectiveUseShadowGit && gitRootPath) params.set('gitRootPath', gitRootPath);
    return params.toString();
  }, [projectPath, effectiveUseShadowGit, gitRootPath]);
  const gitBody = useCallback((extra = {}) => ({
    projectPath,
    shadow: effectiveUseShadowGit,
    ...(!effectiveUseShadowGit && gitRootPath ? { gitRootPath } : {}),
    ...extra,
  }), [projectPath, effectiveUseShadowGit, gitRootPath]);

  const fetchLog = useCallback(async () => {
    if (!projectPath) return;
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/git/log?${gitQuery({ limit: reviewMode ? '80' : '30' })}`);
      if (res.ok) { const d = await res.json(); setCommits(d.commits || []); }
    } catch { /* ignore */ }
    finally { setLoadingLog(false); }
  }, [projectPath, gitQuery, reviewMode]);

  useEffect(() => {
    if ((reviewMode || activeTab === 'log') && projectPath) fetchLog();
  }, [activeTab, projectPath, fetchLog, effectiveUseShadowGit, gitRootPath, reviewMode]);

  useEffect(() => {
    if (reviewMode) return;
    fetchGitStatus();
  }, [effectiveUseShadowGit, gitRootPath, reviewMode]);

  useEffect(() => {
    setExpandedDiffs({});
    setDiffs({});
    setExpandedCommitDiffs({});
    setCommitDiffs({});
  }, [projectPath, gitRootPath]);

  const toggleDiff = async (filePath) => {
    const next = !expandedDiffs[filePath];
    setExpandedDiffs(prev => ({ ...prev, [filePath]: next }));
    if (next && !diffs[filePath]) {
      setLoadingDiffs(prev => ({ ...prev, [filePath]: true }));
      try {
        const res = await fetch(`/api/git/diff?${gitQuery({ filePath })}`);
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
    let hadFailure = false;
    for (const f of gitChanges) {
      if (!f.staged) {
        const ok = await onStageFile(f.path);
        if (!ok) hadFailure = true;
      }
    }
    setDiffs({});
    if (!hadFailure) fetchGitStatus();
  };

  const toggleCommitDiff = async (commitHash) => {
    const next = !expandedCommitDiffs[commitHash];
    setExpandedCommitDiffs(prev => ({ ...prev, [commitHash]: next }));
    if (next && !commitDiffs[commitHash]) {
      setLoadingCommitDiffs(prev => ({ ...prev, [commitHash]: true }));
      try {
        const res = await fetch(`/api/git/diff?${gitQuery({ commit: commitHash })}`);
        if (res.ok) {
          const d = await res.json();
          setCommitDiffs(prev => ({ ...prev, [commitHash]: d.diff || '' }));
        }
      } catch { /* ignore */ }
      finally { setLoadingCommitDiffs(prev => ({ ...prev, [commitHash]: false })); }
    }
  };

  const restoreCommit = async (commit) => {
    if (!projectPath || restoringCommit) return;
    const confirmed = window.confirm(t('gitSidebar.restoreConfirm', { short: commit.short, message: commit.message }));
    if (!confirmed) return;
    setRestoringCommit(commit.hash);
    try {
      const res = await fetch('/api/git/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitBody({ commit: commit.hash })),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t('gitSidebar.restoreFailed'));
      }
      await fetchLog();
      fetchGitStatus();
      onAfterRestore?.(commit);
    } catch (err) {
      window.alert(t('gitSidebar.restoreError', { error: err.message }));
    } finally {
      setRestoringCommit('');
    }
  };

  const hasUnstagedChanges = gitChanges.some(f => !f.staged);

  const tabStyle = (tab) => ({
    flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0',
    fontSize: '11px', fontWeight: activeTab === tab ? 'bold' : 'normal',
    color: activeTab === tab ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
    borderBottom: activeTab === tab ? '2px solid var(--vscode-active-border)' : '2px solid transparent',
  });

  if (!activeProject) return (
    <div className="vscode-sidebar-content" style={{ padding: reviewMode ? '20px' : '12px' }}>
      <div className="vscode-sidebar-title">{reviewMode ? t('gitSidebar.reviewHeader') : t('gitSidebar.header')}</div>
      <div style={{ fontSize: '12px', color: '#808080', fontStyle: 'italic', marginTop: '12px' }}>
        {t('gitSidebar.selectProjectForVcs')}
      </div>
    </div>
  );

  const renderHistory = () => (
    <div style={{ flex: 1, overflowY: 'auto', padding: reviewMode ? '16px 20px 24px' : '12px' }}>
      {loadingLog ? (
        <div style={{ fontSize: '12px', color: '#808080' }}>{t('gitSidebar.loadingHistory')}</div>
      ) : commits.length === 0 ? (
        <div style={{ fontSize: '12px', color: '#808080', fontStyle: 'italic' }}>{t('gitSidebar.noCommits')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: reviewMode ? '8px' : '2px' }}>
          {commits.map((c, i) => (
            <div key={c.hash || i} className={reviewMode ? 'git-review-row' : 'git-commit-row'}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <div style={{ minWidth: reviewMode ? '130px' : 'auto', color: 'var(--vscode-descriptionForeground)', fontSize: reviewMode ? '12px' : '11px' }}>
                  <div style={{ fontFamily: 'monospace', color: '#9cdcfe' }}>{c.short}</div>
                  <div>{c.date}</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'var(--vscode-text-fg)', fontWeight: reviewMode ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: reviewMode ? 'normal' : 'nowrap' }} title={c.message}>
                    {c.message}
                  </div>
                  <div style={{ color: 'var(--vscode-descriptionForeground)', marginTop: '3px' }}>{c.author}</div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    type="button"
                    className={reviewMode ? 'vscode-button secondary' : 'git-icon-button'}
                    title={t('gitSidebar.showCommitDiff')}
                    onClick={() => toggleCommitDiff(c.hash)}
                    style={reviewMode ? { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' } : undefined}
                  >
                    <Eye size={12} /> {reviewMode && t('gitSidebar.diff')}
                  </button>
                  {(reviewMode || effectiveUseShadowGit) && (
                    <button
                      type="button"
                      className={reviewMode ? 'vscode-button' : 'git-icon-button'}
                      title={t('gitSidebar.restoreCheckpoint')}
                      onClick={() => restoreCommit(c)}
                      disabled={!!restoringCommit}
                      style={reviewMode ? { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' } : undefined}
                    >
                      <RotateCcw size={12} /> {reviewMode && (restoringCommit === c.hash ? t('gitSidebar.restoring') : t('gitSidebar.restore'))}
                    </button>
                  )}
                </div>
              </div>
              {expandedCommitDiffs[c.hash] && (
                <div style={{ marginTop: '8px', paddingLeft: reviewMode ? '0' : '12px' }}>
                  {loadingCommitDiffs[c.hash] ? (
                    <div style={{ fontSize: '11px', color: '#808080' }}>{t('gitSidebar.loadingDiff')}</div>
                  ) : (
                    <DiffViewer diff={commitDiffs[c.hash]} wrapLines={reviewMode} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="vscode-sidebar-content" style={{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="vscode-sidebar-title" style={{ margin: 0 }}>{reviewMode ? t('gitSidebar.reviewHeader') : t('gitSidebar.header')}</div>
        <button
          onClick={() => { if (!reviewMode) fetchGitStatus(); if (reviewMode || activeTab === 'log') fetchLog(); }}
          title={t('gitSidebar.refresh')}
          className="git-icon-button"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {!reviewMode && (
      <div style={{ padding: '0 12px 8px' }}>
        <select
          value={useShadowGit ? "shadow" : "user"}
          onChange={(e) => {
            setUseShadowGit(e.target.value === "shadow");
          }}
          className="vscode-settings-input"
          style={{ width: '100%', padding: '4px', borderRadius: '3px', fontSize: '11px' }}
        >
          <option value="user">{t('gitSidebar.userRepository')}</option>
          <option value="shadow">{t('gitSidebar.agentHistory')}</option>
        </select>
        {!useShadowGit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px' }}>
            <div
              className="truncate"
              title={effectiveGitRoot}
              style={{ flex: 1, fontSize: '11px', color: 'var(--vscode-descriptionForeground)', background: 'var(--vscode-input-bg)', border: '1px solid var(--vscode-input-border)', borderRadius: '3px', padding: '3px 5px' }}
            >
              {effectiveGitRoot}
            </div>
            <button
              type="button"
              title={t('gitSidebar.chooseGitRoot')}
              onClick={onPickGitRoot}
              className="git-icon-button"
            >
              <FolderOpen size={13} />
            </button>
            {gitRootPath && (
              <button
                type="button"
                title={t('gitSidebar.clearGitRoot')}
                onClick={onClearGitRoot}
                className="git-icon-button"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {reviewMode && (
        <div style={{ padding: '0 20px 10px', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
          {t('gitSidebar.reviewSubtitle')}
        </div>
      )}

      {/* Tabs */}
      {!reviewMode && (
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
      )}

      {/* Tab: Changes */}
      {!reviewMode && activeTab === 'changes' && (
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
                disabled={!hasUnstagedChanges}
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
      {(reviewMode || activeTab === 'log') && renderHistory()}
    </div>
  );
}
