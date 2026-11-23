import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, CloudDownload, RefreshCw, AlertTriangle, Check, FolderOpen, Cloud, CloudOff, ExternalLink, Square,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleExternalClick } from '../../utils/openExternal';

// The other half of cloud mirroring: a machine that has never seen a project
// finds it in the account and pulls it down, so the same work continues here.
//
// Downloads run in the background on the server so the modal never locks the
// user out of the workspace: closing this dialog keeps the transfer moving, and
// its progress stays visible in the status bar until it finishes.
export default function CloudDownloadModal({
  onClose,
  parentPath,
  onPickParentPath,
  downloads = [],
  onDownloadStarted,
  onCancelDownload,
  onDismissDownload,
  onOpenDownloadedProject,
}) {
  const { t } = useTranslation();

  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('');
  const [baseDir, setBaseDir] = useState('');
  const [auth, setAuth] = useState(null);
  const [projects, setProjects] = useState(null);
  const [selected, setSelected] = useState(null);
  const [folderName, setFolderName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pendingAuthUrl, setPendingAuthUrl] = useState('');
  const [cancellingPaths, setCancellingPaths] = useState(() => new Set());

  // Guards a state update from an in-flight request after the modal closed.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const providerConfig = provider === 'local_folder' ? { base_dir: baseDir } : {};
  const currentProvider = providers.find((p) => p.id === provider);
  const needsAuth = !!currentProvider?.requires_authorization;
  const connected = !!auth?.connected;
  const destination = parentPath && folderName ? `${parentPath}/${folderName}` : '';

  const activeDownloads = downloads.filter(
    (job) => job.status === 'running' || job.status === 'finalizing'
  );
  const hasActiveDownload = activeDownloads.length > 0;
  const activeNamesForProvider = new Set(
    activeDownloads
      .filter((job) => !provider || job.provider === provider)
      .map((job) => job.remote_name)
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/cloud/providers');
        const payload = await res.json();
        if (!mounted.current) return;
        const list = payload.providers || [];
        setProviders(list);
        const first = list.find((p) => p.available);
        if (first) setProvider(first.id);
      } catch (e) {
        if (mounted.current) setError(String(e));
      }
    })();
  }, []);

  // Whether the backend is usable is asked before anything is listed: an
  // account that is not connected yet has to say so, rather than looking like
  // an account with no projects in it.
  const checkAuth = useCallback(async (config) => {
    if (!provider) return null;
    try {
      const res = await fetch('/api/cloud/auth-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config: config || providerConfig }),
      });
      const payload = await res.json();
      if (!mounted.current) return null;
      setAuth(payload);
      return payload;
    } catch (e) {
      if (mounted.current) setError(String(e));
      return null;
    }
  }, [provider, baseDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadProjects = useCallback(async (config) => {
    if (!provider) return;
    setBusy('list');
    setError('');
    try {
      const res = await fetch('/api/cloud/remote-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config: config || providerConfig }),
      });
      const payload = await res.json();
      if (!mounted.current) return;
      if (payload.error) { setError(payload.error); setProjects([]); return; }
      setProjects(payload.projects || []);
    } catch (e) {
      if (mounted.current) { setError(String(e)); setProjects([]); }
    } finally {
      if (mounted.current) setBusy('');
    }
  }, [provider, baseDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching backend invalidates everything that was on screen for the old one.
  useEffect(() => {
    setAuth(null);
    setProjects(null);
    setSelected(null);
    setError('');
    if (!provider) return;
    if (provider === 'local_folder' && !baseDir) return;
    (async () => {
      const state = await checkAuth();
      if (state?.connected) loadProjects();
    })();
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear local optimistic cancelling flags once a job is no longer running.
  useEffect(() => {
    const runningPaths = new Set(
      downloads.filter((j) => j.status === 'running').map((j) => j.project_path)
    );
    setCancellingPaths((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((p) => {
        if (runningPaths.has(p)) next.add(p);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [downloads]);

  const applyBaseDir = async () => {
    if (!baseDir) return;
    const config = { base_dir: baseDir };
    const state = await checkAuth(config);
    if (state?.connected) loadProjects(config);
  };

  const connect = async () => {
    setBusy('connect');
    setError('');
    setPendingAuthUrl('');
    try {
      const res = await fetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config: providerConfig }),
      });
      const challenge = await res.json();
      if (challenge.error) { setError(challenge.error); return; }
      // Shown so the user can still finish the flow when no browser could be
      // launched — a headless session, or a sandbox without a portal.
      setPendingAuthUrl(challenge.authorization_url || '');

      const done = await fetch('/api/cloud/connect/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, session: challenge.session, config: providerConfig }),
      });
      const result = await done.json();
      if (result.error) { setError(result.error); return; }
      setPendingAuthUrl('');
      const state = await checkAuth();
      if (state?.connected) loadProjects();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const pick = (project) => {
    if (project.local || project.downloading || activeNamesForProvider.has(project.name)) return;
    setSelected(project);
    setFolderName(project.name);
    setError('');
  };

  const startDownload = async () => {
    if (!selected || !parentPath || !folderName) return;
    setBusy('start');
    setError('');
    try {
      const res = await fetch('/api/cloud/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          config: providerConfig,
          name: selected.name,
          root: selected.root,
          parentPath,
          folderName,
          background: true,
        }),
      });
      const payload = await res.json();
      if (!mounted.current) return;
      if (!res.ok || payload.error) {
        setError(payload.error || `HTTP ${res.status}`);
        return;
      }
      if (payload.job) {
        onDownloadStarted?.(payload.job);
      }
      setSelected(null);
      setFolderName('');
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const handleCancelJob = async (job) => {
    if (!job?.project_path) return;
    setCancellingPaths((prev) => new Set(prev).add(job.project_path));
    try {
      const err = await onCancelDownload?.(job.project_path);
      if (mounted.current && err) {
        setError(err);
        setCancellingPaths((prev) => {
          const next = new Set(prev);
          next.delete(job.project_path);
          return next;
        });
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    }
  };

  const starting = busy === 'start';

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '620px', maxHeight: 'calc(85 * var(--ui-vh))', padding: 0 }}>
        <div className="vscode-modal-header titlebar">
          <div className="vscode-modal-header-title">
            <CloudDownload size={16} />
            <span>{t('cloudDownload.title', 'Download a project from the cloud')}</span>
          </div>
          <button
            className="vscode-modal-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="vscode-modal-content flex flex-col" style={{ overflowY: 'auto', gap: '14px' }}>
          <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0 }}>
            {t('cloudDownload.intro', 'Projects you mirror to the cloud on another computer can be downloaded here and worked on from this one. They keep syncing afterwards.')}
          </p>

          {error && (
            <div
              className="flex items-start"
              style={{ gap: '8px', padding: '8px 10px', fontSize: '11px', border: '1px solid var(--vscode-fg-danger)', color: 'var(--vscode-fg-danger)', borderRadius: '3px' }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{error}</span>
            </div>
          )}

          {downloads.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                {t('cloudDownload.activeDownloads', 'Downloads')}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {downloads.map((job) => {
                  const jobName = job.folder_name || job.remote_name;
                  const progress = job.progress;
                  const isRunning = job.status === 'running';
                  const isFinalizing = job.status === 'finalizing';
                  const isCancelling = isRunning && (job.cancel_requested || cancellingPaths.has(job.project_path));
                  const pct = isRunning && progress?.total
                    ? Math.min(100, Math.round(((progress.examined || 0) / progress.total) * 100))
                    : 0;
                  const downloadedCount = (job.project?.report?.downloaded || job.report?.downloaded || []).length;

                  return (
                    <div
                      key={job.id}
                      style={{
                        border: `1px solid ${job.status === 'failed' ? 'var(--vscode-fg-danger)' : 'var(--vscode-border)'}`,
                        borderRadius: '3px',
                        padding: '8px 10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div className="flex items-center justify-between" style={{ gap: '8px' }}>
                        <span className="flex items-center truncate" style={{ gap: '6px', fontSize: '12px', fontWeight: 600 }}>
                          {isRunning || isFinalizing ? (
                            <RefreshCw size={12} className="animate-spin" style={{ flexShrink: 0 }} />
                          ) : job.status === 'completed' ? (
                            <Check size={12} style={{ flexShrink: 0, color: 'var(--vscode-accent)' }} />
                          ) : job.status === 'failed' ? (
                            <AlertTriangle size={12} style={{ flexShrink: 0, color: 'var(--vscode-fg-danger)' }} />
                          ) : (
                            <CloudDownload size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                          )}
                          <span className="truncate">{jobName}</span>
                        </span>

                        <div className="flex items-center" style={{ gap: '6px', flexShrink: 0 }}>
                          {isRunning && (
                            <button
                              className="vscode-button"
                              onClick={() => handleCancelJob(job)}
                              disabled={isCancelling}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--vscode-border)',
                                color: 'var(--vscode-text-fg)',
                                padding: '2px 8px',
                                fontSize: '11px',
                              }}
                            >
                              <Square size={10} />
                              {isCancelling
                                ? t('cloudSync.cancelling', 'Cancelling…')
                                : t('cloudDownload.cancel', 'Cancel download')}
                            </button>
                          )}
                          {job.status === 'completed' && job.project && (
                            <button
                              className="vscode-button"
                              onClick={() => onOpenDownloadedProject?.(job)}
                              style={{ padding: '2px 8px', fontSize: '11px' }}
                            >
                              {t('cloudDownload.openProject', 'Open project')}
                            </button>
                          )}
                          {!isRunning && !isFinalizing && (
                            <button
                              onClick={() => onDismissDownload?.(job.id)}
                              title={t('cloudDownload.dismiss', 'Dismiss')}
                              aria-label={t('cloudDownload.dismiss', 'Dismiss')}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'var(--vscode-text-subtle)',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      {isRunning && (
                        <>
                          <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                            {isCancelling
                              ? t('cloudDownload.cancelling', 'Cancelling — finishing the file in progress…')
                              : progress?.total
                              ? t('cloudDownload.progress', {
                                  examined: progress.examined,
                                  total: progress.total,
                                  path: progress.current_path || '',
                                  defaultValue: 'Downloading {{examined}} of {{total}} — {{path}}',
                                })
                              : t('cloudDownload.starting', 'Starting the download…')}
                          </div>
                          {progress?.total > 0 && (
                            <div style={{ height: '4px', background: 'var(--vscode-border)', borderRadius: '2px', overflow: 'hidden' }}>
                              <div
                                style={{
                                  width: `${pct}%`,
                                  height: '100%',
                                  background: 'var(--vscode-accent, #6656e0)',
                                  transition: 'width 0.25s ease',
                                }}
                              />
                            </div>
                          )}
                        </>
                      )}

                      {isFinalizing && (
                        <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                          {t('cloudDownload.finalizing', 'Finishing setup and importing chats…')}
                        </div>
                      )}

                      {job.status === 'completed' && (
                        <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                          {t('cloudDownload.completedSummary', {
                            count: downloadedCount,
                            defaultValue: 'Downloaded ({{count}} file(s))',
                          })}
                        </div>
                      )}

                      {job.status === 'cancelled' && (
                        <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                          {t('cloudDownload.cancelled', 'Download cancelled. The partial copy was removed; nothing was added to your projects.')}
                        </div>
                      )}

                      {job.status === 'failed' && (
                        <div style={{ fontSize: '11px', color: 'var(--vscode-fg-danger)' }}>
                          {job.error}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Where to look */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
              {t('cloudSync.provider', 'Provider')}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={starting}
              className="vscode-settings-input"
              style={{ width: '100%' }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.display_name}{p.available ? '' : ` — ${p.unavailable_reason}`}
                </option>
              ))}
            </select>
          </div>

          {provider === 'local_folder' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                {t('cloudSync.baseDir', 'Destination folder')}
              </label>
              <input
                type="text"
                className="vscode-settings-input"
                value={baseDir}
                disabled={starting}
                placeholder={t('cloudSync.baseDirPlaceholder', '/home/you/Drive/OpalaTex')}
                onChange={(e) => setBaseDir(e.target.value)}
                onBlur={applyBaseDir}
                onKeyDown={(e) => { if (e.key === 'Enter') applyBaseDir(); }}
              />
            </div>
          )}

          {needsAuth && (
            <div className="flex items-center justify-between" style={{ gap: '8px' }}>
              <span className="flex items-center" style={{ gap: '6px', fontSize: '12px' }}>
                {connected ? <Cloud size={14} /> : <CloudOff size={14} />}
                {connected
                  ? t('cloudSync.connectedAs', { account: auth?.account || '' })
                  : t('cloudSync.notConnected', 'Not connected')}
              </span>
              {!connected && (
                <button className="vscode-button" onClick={connect} disabled={!!busy}>
                  {busy === 'connect'
                    ? t('cloudSync.connecting', 'Waiting for authorization…')
                    : t('cloudSync.connect', 'Connect')}
                </button>
              )}
            </div>
          )}

          {pendingAuthUrl && (
            <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', lineHeight: 1.5 }}>
              <div style={{ marginBottom: '4px' }}>
                {t('cloudSync.waitingBrowser', 'Waiting for you to finish in the browser…')}
              </div>
              <a
                href={pendingAuthUrl}
                onClick={handleExternalClick(pendingAuthUrl)}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--vscode-accent)', wordBreak: 'break-all', cursor: 'pointer' }}
              >
                <ExternalLink size={11} style={{ display: 'inline', marginRight: '4px' }} />
                {pendingAuthUrl}
              </a>
            </div>
          )}

          {/* Pressing Connect reports the same failure the status check already
              found, so the two would otherwise print the identical paragraph
              twice, one above the other. */}
          {auth && !connected && auth.error && auth.error !== error && (
            <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>{auth.error}</div>
          )}

          {/* What is up there */}
          {connected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div className="flex items-center justify-between">
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudDownload.projects', 'Projects in the cloud')}
                </label>
                <button
                  onClick={() => loadProjects()}
                  disabled={!!busy}
                  title={t('cloudDownload.refresh', 'Refresh')}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)' }}
                >
                  <RefreshCw size={13} className={busy === 'list' ? 'animate-spin' : ''} />
                </button>
              </div>

              <div style={{ border: '1px solid var(--vscode-border)', borderRadius: '3px', maxHeight: '190px', overflowY: 'auto' }}>
                {busy === 'list' && (
                  <div style={{ padding: '10px', fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                    {t('cloudDownload.loading', 'Looking for projects…')}
                  </div>
                )}
                {busy !== 'list' && projects && projects.length === 0 && (
                  <div style={{ padding: '10px', fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                    {t('cloudDownload.empty', 'No projects here yet. Turn on cloud sync for a project on your other computer first.')}
                  </div>
                )}
                {busy !== 'list' && (projects || []).map((project) => {
                  const isDownloadingProject = !!project.downloading || activeNamesForProvider.has(project.name);
                  const unavailable = !!project.local || isDownloadingProject;
                  const isSelected = selected?.name === project.name;
                  return (
                    <div
                      key={project.name}
                      onClick={() => pick(project)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                        padding: '6px 10px', fontSize: '12px',
                        cursor: unavailable ? 'default' : 'pointer',
                        opacity: unavailable ? 0.55 : 1,
                        background: isSelected ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                        borderBottom: '1px solid var(--vscode-border)',
                      }}
                    >
                      <span className="flex items-center truncate" style={{ gap: '6px' }}>
                        {isSelected ? <Check size={12} style={{ flexShrink: 0 }} /> : <Cloud size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                        <span className="truncate">{project.name}</span>
                      </span>
                      {project.local ? (
                        <span
                          style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', flexShrink: 0 }}
                          title={project.local.project_path}
                        >
                          {t('cloudDownload.alreadyHere', 'already on this computer')}
                        </span>
                      ) : isDownloadingProject ? (
                        <span style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', flexShrink: 0 }}>
                          {t('cloudDownload.downloadingTag', 'downloading…')}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Where it lands */}
          {selected && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudDownload.parent', 'Save inside')}
                </label>
                <div className="flex items-center" style={{ gap: '6px' }}>
                  <input
                    type="text"
                    className="vscode-settings-input"
                    style={{ flex: 1 }}
                    value={parentPath || ''}
                    readOnly
                    placeholder={t('cloudDownload.parentPlaceholder', 'Choose a folder…')}
                  />
                  <button
                    className="vscode-button"
                    onClick={onPickParentPath}
                    disabled={starting}
                    style={{ flexShrink: 0 }}
                  >
                    <FolderOpen size={12} /> {t('cloudDownload.browse', 'Browse')}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudDownload.folderName', 'New folder name')}
                </label>
                <input
                  type="text"
                  className="vscode-settings-input"
                  value={folderName}
                  disabled={starting}
                  onChange={(e) => setFolderName(e.target.value)}
                />
                <span style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                  {destination
                    ? t('cloudDownload.destinationHint', { path: destination, defaultValue: 'The project will be downloaded to {{path}}. The folder must be new or empty.' })
                    : t('cloudDownload.chooseParent', 'Choose the folder the project will be created in.')}
                </span>
              </div>
            </>
          )}

          <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0 }}>
            {t('cloudDownload.envNotice', 'The project .env is not mirrored, so API keys stay on the computer they were entered on. Add yours in the project settings after downloading.')}
          </p>
        </div>

        <div className="vscode-modal-footer titlebar items-center">
          <button
            className="vscode-button"
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
          >
            {hasActiveDownload
              ? t('cloudDownload.continueInBackground', 'Continue in background')
              : t('cloudSync.close', 'Close')}
          </button>
          <button
            className="vscode-button"
            onClick={startDownload}
            disabled={starting || !selected || !parentPath || !folderName}
          >
            <CloudDownload size={12} />
            {starting
              ? t('cloudDownload.starting', 'Starting the download…')
              : t('cloudDownload.download', 'Download project')}
          </button>
        </div>
      </div>
    </div>
  );
}
