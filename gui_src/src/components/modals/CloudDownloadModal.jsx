import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, CloudDownload, RefreshCw, AlertTriangle, Check, FolderOpen, Cloud, CloudOff, KeyRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

// The other half of cloud mirroring: a machine that has never seen a project
// finds it in the account and pulls it down, so the same work continues here.
//
// It is deliberately its own modal rather than a tab of CloudSyncModal — that
// panel configures the project you already have open, and this flow exists
// precisely when there is no such project yet.
export default function CloudDownloadModal({ onClose, onDownloaded, parentPath, onPickParentPath }) {
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
  const [progress, setProgress] = useState(null);
  const [pendingAuthUrl, setPendingAuthUrl] = useState('');
  // Which OAuth client this installation connects with. A build that ships one
  // never shows this; a source checkout has to be able to register a client
  // here, because on a machine with no projects yet there is no project panel
  // to go and do it in.
  const [googleClient, setGoogleClient] = useState(null);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');

  // Guards a state update from an in-flight request after the modal closed.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const providerConfig = provider === 'local_folder' ? { base_dir: baseDir } : {};
  const currentProvider = providers.find((p) => p.id === provider);
  const needsAuth = !!currentProvider?.requires_authorization;
  const connected = !!auth?.connected;
  const destination = parentPath && folderName ? `${parentPath}/${folderName}` : '';

  const loadGoogleClient = useCallback(async () => {
    try {
      const res = await fetch('/api/cloud/google-client');
      const payload = await res.json();
      if (!mounted.current) return;
      setGoogleClient(payload);
      setCustomClientId(payload.custom_client_id || '');
    } catch (_) { /* the panel still works without it */ }
  }, []);

  useEffect(() => { loadGoogleClient(); }, [loadGoogleClient]);

  const saveGoogleClient = async () => {
    setBusy('client');
    setError('');
    try {
      const res = await fetch('/api/cloud/google-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: customClientId, client_secret: customClientSecret }),
      });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); return; }
      // The secret is write-only: it is never sent back, so the field is
      // cleared rather than left holding a value the user cannot verify.
      setCustomClientSecret('');
      await loadGoogleClient();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

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
    if (project.local) return;
    setSelected(project);
    setFolderName(project.name);
    setError('');
  };

  const download = async () => {
    if (!selected || !parentPath || !folderName) return;
    setBusy('download');
    setError('');
    setProgress(null);

    // The pass runs in a worker thread on the server, so its progress is polled
    // the same way the sync panel polls a running pass.
    const target = `${parentPath}/${folderName}`;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/cloud/status?${new URLSearchParams({ projectPath: target })}`);
        const payload = await res.json();
        if (mounted.current && payload.progress?.active) setProgress(payload.progress);
      } catch (_) { /* progress is a nicety; the download is what matters */ }
    }, 1000);

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
        }),
      });
      const payload = await res.json();
      if (!res.ok || payload.error) { setError(payload.error || `HTTP ${res.status}`); return; }
      onDownloaded?.(payload);
    } catch (e) {
      setError(String(e));
    } finally {
      clearInterval(timer);
      if (mounted.current) { setBusy(''); setProgress(null); }
    }
  };

  const downloading = busy === 'download';

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '620px', maxHeight: 'calc(85 * var(--ui-vh))', padding: 0 }}>
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--vscode-border)', backgroundColor: 'var(--vscode-titlebar-bg)' }}
        >
          <div className="flex items-center" style={{ gap: '8px' }}>
            <CloudDownload size={16} />
            <span style={{ fontWeight: 'bold', fontSize: '13px' }}>
              {t('cloudDownload.title', 'Download a project from the cloud')}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={downloading}
            style={{ background: 'none', border: 'none', color: 'var(--vscode-text-fg)', cursor: downloading ? 'default' : 'pointer', padding: '2px' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0 }}>
            {t('cloudDownload.intro', 'Projects you mirror to the cloud on another computer can be downloaded here and worked on from this one. They keep syncing afterwards.')}
          </p>

          {error && (
            <div
              className="flex items-start"
              style={{ gap: '8px', padding: '8px 10px', fontSize: '11px', border: '1px solid #f87171', color: '#f87171', borderRadius: '3px' }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{error}</span>
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
              disabled={downloading}
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
                disabled={downloading}
                placeholder={t('cloudSync.baseDirPlaceholder', '/home/you/Drive/OpalaTex')}
                onChange={(e) => setBaseDir(e.target.value)}
                onBlur={applyBaseDir}
                onKeyDown={(e) => { if (e.key === 'Enter') applyBaseDir(); }}
              />
            </div>
          )}

          {/* Only a build that carries no OAuth client of its own ever shows this. */}
          {provider === 'google_drive' && googleClient && !googleClient.configured && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span className="flex items-center" style={{ gap: '6px', fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                <KeyRound size={12} style={{ flexShrink: 0 }} />
                {t('cloudSync.googleClientHelp')}
              </span>
              <input
                type="text"
                className="vscode-settings-input"
                value={customClientId}
                placeholder={t('cloudSync.clientId', 'Client ID')}
                onChange={(e) => setCustomClientId(e.target.value)}
              />
              <input
                type="password"
                className="vscode-settings-input"
                value={customClientSecret}
                placeholder={googleClient.has_custom_client_secret
                  ? t('cloudSync.clientSecretStored', 'Stored — leave blank to keep it')
                  : t('cloudSync.clientSecret', 'Client secret')}
                onChange={(e) => setCustomClientSecret(e.target.value)}
              />
              <button
                className="vscode-button"
                onClick={saveGoogleClient}
                disabled={busy === 'client' || !customClientId}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('cloudSync.saveClient', 'Save credentials')}
              </button>
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
                <button
                  className="vscode-button"
                  onClick={connect}
                  disabled={!!busy || (provider === 'google_drive' && googleClient && !googleClient.configured)}
                >
                  {busy === 'connect'
                    ? t('cloudSync.connecting', 'Waiting for authorization…')
                    : t('cloudSync.connect', 'Connect')}
                </button>
              )}
            </div>
          )}

          {pendingAuthUrl && (
            <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', wordBreak: 'break-all' }}>
              {t('cloudSync.waitingBrowser', 'Waiting for you to finish in the browser…')}
              <div style={{ marginTop: '4px', fontFamily: 'monospace' }}>{pendingAuthUrl}</div>
            </div>
          )}

          {auth && !connected && auth.error && (
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
                  const isSelected = selected?.name === project.name;
                  return (
                    <div
                      key={project.name}
                      onClick={() => pick(project)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                        padding: '6px 10px', fontSize: '12px',
                        cursor: project.local ? 'default' : 'pointer',
                        opacity: project.local ? 0.55 : 1,
                        background: isSelected ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                        borderBottom: '1px solid var(--vscode-border)',
                      }}
                    >
                      <span className="flex items-center truncate" style={{ gap: '6px' }}>
                        {isSelected ? <Check size={12} style={{ flexShrink: 0 }} /> : <Cloud size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                        <span className="truncate">{project.name}</span>
                      </span>
                      {project.local && (
                        <span
                          style={{ fontSize: '10px', color: 'var(--vscode-text-subtle)', flexShrink: 0 }}
                          title={project.local.project_path}
                        >
                          {t('cloudDownload.alreadyHere', 'already on this computer')}
                        </span>
                      )}
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
                    disabled={downloading}
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
                  disabled={downloading}
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

          {downloading && (
            <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
              {progress?.total
                ? t('cloudDownload.progress', {
                    examined: progress.examined,
                    total: progress.total,
                    path: progress.current_path || '',
                    defaultValue: 'Downloading {{examined}} of {{total}} — {{path}}',
                  })
                : t('cloudDownload.starting', 'Starting the download…')}
            </div>
          )}

          <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0 }}>
            {t('cloudDownload.envNotice', 'The project .env is not mirrored, so API keys stay on the computer they were entered on. Add yours in the project settings after downloading.')}
          </p>
        </div>

        <div
          className="flex items-center justify-end px-4 py-3"
          style={{ borderTop: '1px solid var(--vscode-border)', gap: '8px', backgroundColor: 'var(--vscode-titlebar-bg)' }}
        >
          <button
            className="vscode-button"
            onClick={onClose}
            disabled={downloading}
            style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
          >
            {t('cloudSync.close', 'Close')}
          </button>
          <button
            className="vscode-button"
            onClick={download}
            disabled={downloading || !selected || !parentPath || !folderName}
          >
            <CloudDownload size={12} />
            {downloading
              ? t('cloudDownload.downloading', 'Downloading…')
              : t('cloudDownload.download', 'Download project')}
          </button>
        </div>
      </div>
    </div>
  );
}
