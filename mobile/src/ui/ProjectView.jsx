import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { ArrowLeft, CloudOff, Files, MessageSquare, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import ChatList from './ChatList.jsx';
import ChatView from './ChatView.jsx';
import FileBrowser from './FileBrowser.jsx';
import OfflineCard from './OfflineCard.jsx';

const POLL_MS = 60 * 1000;

export default function ProjectView({ services, settings, project, session, onBack, onOpenSettings, onSettingsChange }) {
  const { t } = useTranslation();
  const [conversation, setConversation] = useState(null);
  const [status, setStatus] = useState({ state: 'syncing' });
  const [tab, setTab] = useState('chats');
  const [openChatId, setOpenChatId] = useState(null);
  const [draft, setDraft] = useState('');
  const busyTurn = useRef(false);

  // ── Available offline ──
  const offlineEnabled = Boolean(settings.offlineProjects?.[project.root]);
  const offlineEnabledRef = useRef(offlineEnabled);
  offlineEnabledRef.current = offlineEnabled;
  const [offline, setOffline] = useState({ status: null, progress: null, error: '' });
  const prefetchRef = useRef(null);

  const refreshOfflineStatus = useCallback(async () => {
    const status = await session.workspace.offlineStatus().catch(() => null);
    setOffline((current) => ({ ...current, status }));
  }, [session]);

  const runPrefetch = useCallback(async () => {
    if (prefetchRef.current || !offlineEnabledRef.current) return;
    const controller = new AbortController();
    const run = (async () => {
      setOffline((current) => ({ ...current, error: '' }));
      try {
        await session.workspace.prefetch({
          signal: controller.signal,
          onProgress: (progress) => setOffline((current) => ({ ...current, progress: progress.total ? progress : null })),
        });
      } catch (error) {
        setOffline((current) => ({ ...current, error: error?.message || String(error) }));
      } finally {
        prefetchRef.current = null;
        setOffline((current) => ({ ...current, progress: null }));
        await refreshOfflineStatus();
      }
    })();
    prefetchRef.current = { controller, run };
    await run;
  }, [session, refreshOfflineStatus]);

  const toggleOffline = useCallback(async (enabled) => {
    const offlineProjects = { ...(settings.offlineProjects || {}) };
    if (enabled) offlineProjects[project.root] = true;
    else delete offlineProjects[project.root];
    offlineEnabledRef.current = enabled;
    await onSettingsChange({ ...settings, offlineProjects });
    if (enabled) {
      // Ask the web view not to evict this storage under pressure; a no-op
      // where the browser does not support it.
      globalThis.navigator?.storage?.persist?.().catch(() => {});
      runPrefetch();
    } else {
      // The file in flight still lands; wait for it so the purge removes it too.
      const running = prefetchRef.current;
      running?.controller.abort();
      await running?.run;
      await session.workspace.purgeCache().catch(() => {});
      setOffline({ status: null, progress: null, error: '' });
      await refreshOfflineStatus();
    }
  }, [settings, project.root, onSettingsChange, runPrefetch, session, refreshOfflineStatus]);

  useEffect(() => () => prefetchRef.current?.controller.abort(), []);

  const sync = useCallback(async () => {
    setStatus((current) => ({ ...current, state: 'syncing' }));
    try {
      await session.push().catch(() => {});
      const next = await session.pull();
      setConversation(next);
      // The offline copy follows every successful sync: only what changed is
      // downloaded, and copies of removed files are dropped.
      if (!session.workspace.offline) runPrefetch();
      else refreshOfflineStatus();
      await session.push().catch(() => {});
      const pending = await session.pendingUpload();
      setStatus({
        state: session.workspace.offline ? 'offline' : pending ? 'pending' : 'synced',
        problems: session.problems,
      });
    } catch (error) {
      setConversation(await session.conversation().catch(() => null));
      setStatus({ state: 'failed', message: error?.message || String(error), problems: session.problems });
    }
  }, [session, runPrefetch, refreshOfflineStatus]);

  useEffect(() => {
    // Show what this device already holds at once; the sync then updates it in
    // place. Without this the screen is empty until Drive has been walked.
    let cancelled = false;
    session.restore()
      .then((cached) => {
        if (cached && !cancelled) {
          setConversation((current) => current || cached);
          refreshOfflineStatus();
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) sync(); });
    const timer = setInterval(() => { if (!busyTurn.current && document.visibilityState === 'visible') sync(); }, POLL_MS);
    const listeners = [];
    CapacitorApp.addListener('appStateChange', ({ isActive }) => { if (isActive && !busyTurn.current) sync(); })
      .then((handle) => listeners.push(handle)).catch(() => {});
    Network.addListener('networkStatusChange', ({ connected }) => { if (connected && !busyTurn.current) sync(); })
      .then((handle) => listeners.push(handle)).catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(timer);
      listeners.forEach((handle) => handle.remove());
    };
  }, [sync, session, refreshOfflineStatus]);

  const refreshConversation = useCallback(async () => {
    setConversation(await session.conversation());
    const pending = await session.pendingUpload();
    setStatus((current) => ({ ...current, state: session.workspace.offline ? 'offline' : pending ? 'pending' : 'synced' }));
  }, [session]);

  const askAboutFile = useCallback((path) => {
    setDraft(t('chat.askAboutFile', { path }));
    setOpenChatId(null);
    setTab('chats');
    setOpenChatId('__new__');
  }, [t]);

  const chat = openChatId && openChatId !== '__new__'
    ? conversation?.chats.find((candidate) => candidate.id === openChatId) || null
    : null;

  const problem = status.problems?.find((p) => p.code === 'no-export' || p.code === 'export-newer-format');

  // The project screen stays mounted under an open chat, and both tabs stay
  // mounted while hidden, so going back finds the list, the open folder and
  // the scroll position as they were.
  return (
    <>
      <div className="screen" hidden={Boolean(openChatId)}>
        <header className="bar">
          <button type="button" className="icon" onClick={onBack} aria-label={t('app.back')}><ArrowLeft size={20} /></button>
          <h1 className="ellipsis">{project.name}</h1>
          <div className="bar-actions">
            <button type="button" className="icon" onClick={sync} aria-label={t('projects.refresh')}>
              <RefreshCw size={20} className={status.state === 'syncing' ? 'spin' : ''} />
            </button>
            <button type="button" className="icon" onClick={onOpenSettings} aria-label={t('projects.settings')}><SettingsIcon size={20} /></button>
          </div>
        </header>
        <SyncStatus status={status} />
        {problem && (
          <p className="notice">{t(problem.code === 'no-export' ? 'project.noExport' : 'project.exportNewer')}</p>
        )}
        <main className="scroll" hidden={tab !== 'chats'}>
          <ChatList conversation={conversation} onOpen={setOpenChatId} onNew={() => setOpenChatId('__new__')} />
        </main>
        <main className="scroll" hidden={tab !== 'files'}>
          <FileBrowser
            workspace={session.workspace}
            version={conversation}
            onAsk={askAboutFile}
            header={<OfflineCard enabled={offlineEnabled} state={offline} onToggle={toggleOffline} />}
          />
        </main>
        <nav className="tabs">
          <button type="button" className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>
            <MessageSquare size={20} /><span>{t('project.chats')}</span>
          </button>
          <button type="button" className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            <Files size={20} /><span>{t('project.files')}</span>
          </button>
        </nav>
      </div>
      {openChatId && (
        <ChatView
          services={services}
          settings={settings}
          project={project}
          session={session}
          conversation={conversation}
          chat={chat}
          initialDraft={draft}
          onDraftUsed={() => setDraft('')}
          onBack={() => { setOpenChatId(null); sync(); }}
          onChatCreated={(created) => setOpenChatId(created.id)}
          onChanged={refreshConversation}
          onBusy={(busy) => { busyTurn.current = busy; }}
          onOpenSettings={onOpenSettings}
          onSettingsChange={onSettingsChange}
          status={status}
        />
      )}
    </>
  );
}

export function SyncStatus({ status }) {
  const { t } = useTranslation();
  if (!status || status.state === 'synced') return null;
  const text = {
    syncing: t('project.syncing'),
    pending: t('project.pending'),
    offline: t('project.offline'),
    failed: t('project.syncFailed', { message: status.message }),
  }[status.state];
  return (
    <div className={`sync-status ${status.state}`} role="status">
      {status.state === 'offline' && <CloudOff size={14} />}
      <span>{text}</span>
    </div>
  );
}
