import React from 'react';
import { Info, CaseSensitive, Cloud, CloudOff, CloudDownload, RefreshCw, AlertTriangle, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { COUNT_MODE_AUTO } from '../utils/textStats';

// The status bar has room for a file name, not a path.
function baseName(relPath) {
  const parts = String(relPath || '').split('/');
  return parts[parts.length - 1] || '';
}

// Bottom status bar (VSCode-style footer).
export default function StatusBar({
  activeProject,
  isAgentRunning,
  textStats,
  cloudStatus,
  onOpenCloudSync,
  cloudDownloads = [],
  onOpenCloudDownload,
  onOpenDownloadedProject,
  onDismissCloudDownload,
}) {
  const { t, i18n } = useTranslation();

  const formatNumber = (value) => Number(value || 0).toLocaleString(i18n.language);

  const modeLabel = textStats ? t(`statusBar.countMode.${textStats.mode}`) : '';
  // The label shows the effective mode; "(auto)" tells the user it was
  // detected from the file type rather than pinned by hand.
  const modeSuffix = textStats && textStats.modeOverride === COUNT_MODE_AUTO
    ? t('statusBar.countModeAutoSuffix')
    : '';

  // The selection replaces the document count while text is selected, the way
  // a word processor does — that is the number the user just asked for.
  const shownStats = textStats?.selection || textStats;

  const countTooltip = textStats ? [
    t('statusBar.countTooltipMode', { mode: `${modeLabel}${modeSuffix}` }),
    t('statusBar.countTooltipWords', { value: formatNumber(textStats.words) }),
    t('statusBar.countTooltipChars', { value: formatNumber(textStats.characters) }),
    t('statusBar.countTooltipCharsNoSpaces', { value: formatNumber(textStats.charactersNoSpaces) }),
    t('statusBar.countTooltipLines', { value: formatNumber(textStats.lines) }),
    t('statusBar.countTooltipRaw', { value: formatNumber(textStats.rawCharacters) }),
    textStats.selection
      ? t('statusBar.countTooltipSelection', {
        words: formatNumber(textStats.selection.words),
        characters: formatNumber(textStats.selection.characters),
      })
      : null,
    '',
    t('statusBar.countTooltipHint'),
  ].filter(item => item !== null).join('\n') : '';

  // Cloud sync indicator. An error outranks a running pass: a sync that keeps
  // failing is the one thing here the user has to act on.
  const cloudError = cloudStatus?.last_error || cloudStatus?.auth_error || '';
  const cloudSyncing = !!cloudStatus?.syncing;
  const cloudIcon = cloudSyncing
    ? <RefreshCw size={12} className="animate-spin" />
    : cloudError
      ? <AlertTriangle size={12} style={{ color: 'var(--vscode-fg-warning)' }} />
      : cloudStatus?.connected || cloudStatus?.settings?.provider === 'local_folder'
        ? <Cloud size={12} />
        : <CloudOff size={12} />;
  // While a pass runs, the label names the file being moved and how far along
  // the pass is: "Syncing…" alone left the user unable to tell a working sync
  // from a stuck one.
  const progress = cloudStatus?.progress || null;
  const progressActive = cloudSyncing || !!progress?.active;
  const currentFile = progress?.current_path ? baseName(progress.current_path) : '';
  const counter = progress?.total
    ? `${Math.min(progress.examined || 0, progress.total)}/${progress.total}`
    : '';
  const syncingLabel = currentFile
    ? t('statusBar.cloudSyncingFile', {
      defaultValue: 'Syncing {{file}} ({{counter}})',
      file: currentFile,
      counter: counter || '…',
    })
    : t('statusBar.cloudSyncing', 'Syncing…');
  const conflictCount = cloudStatus?.last_outcome?.report?.conflicts?.length || 0;
  const cloudLabel = progressActive
    ? syncingLabel
    : cloudError
      ? t('statusBar.cloudError', 'Sync issue')
      : conflictCount
        ? t('statusBar.cloudConflicts', {
          defaultValue: '{{count}} conflict(s)',
          count: conflictCount,
        })
        : cloudStatus?.last_sync_at
          ? t('statusBar.cloudSynced', 'Synced')
          : t('statusBar.cloudPending', 'Not synced yet');
  const cloudTooltip = [
    t('statusBar.cloudTooltipProvider', {
      defaultValue: 'Cloud sync: {{provider}}',
      provider: cloudStatus?.settings?.provider || '—',
    }),
    cloudStatus?.account
      ? t('statusBar.cloudTooltipAccount', { defaultValue: 'Account: {{account}}', account: cloudStatus.account })
      : null,
    cloudStatus?.last_sync_at
      ? t('statusBar.cloudTooltipLast', {
        defaultValue: 'Last pass: {{when}}',
        when: new Date(cloudStatus.last_sync_at).toLocaleString(),
      })
      : null,
    progress?.current_path
      ? t('statusBar.cloudTooltipCurrent', {
        defaultValue: 'Now: {{action}} {{path}}',
        action: progress.current_action || 'sync',
        path: progress.current_path,
      })
      : null,
    !progressActive && progress?.counts && Object.keys(progress.counts).length
      ? t('statusBar.cloudTooltipMoved', {
        defaultValue: 'Last pass moved: {{summary}}',
        summary: Object.entries(progress.counts)
          .map(([action, count]) => `${action} ${count}`)
          .join(', '),
      })
      : null,
    conflictCount
      ? t('statusBar.cloudTooltipConflicts', {
        defaultValue: '{{count}} file(s) need a decision — click to resolve',
        count: conflictCount,
      })
      : null,
    cloudError || null,
  ].filter(Boolean).join('\n');

  // Background cloud project downloads: active transfers take priority over
  // completed or failed notices so the user always sees live progress without
  // needing the download modal open.
  const activeDownloads = cloudDownloads.filter(
    (job) => job.status === 'running' || job.status === 'finalizing'
  );
  const failedDownload = cloudDownloads.find((job) => job.status === 'failed') || null;
  const completedDownload = cloudDownloads.find((job) => job.status === 'completed' && job.project) || null;
  const primaryActiveDownload = activeDownloads[0] || null;
  const extraActiveCount = Math.max(0, activeDownloads.length - 1);

  let downloadIndicator = null;
  if (primaryActiveDownload) {
    const jobName = primaryActiveDownload.folder_name || primaryActiveDownload.remote_name;
    const dlProgress = primaryActiveDownload.progress || null;
    const dlCounter = dlProgress?.total
      ? `${Math.min(dlProgress.examined || 0, dlProgress.total)}/${dlProgress.total}`
      : '';
    const dlLabelBase = primaryActiveDownload.status === 'finalizing'
      ? t('statusBar.cloudDownloadFinalizing', {
        defaultValue: 'Finalizing {{name}}…',
        name: jobName,
      })
      : primaryActiveDownload.cancel_requested
        ? t('statusBar.cloudDownloadCancelling', {
          defaultValue: 'Cancelling {{name}}…',
          name: jobName,
        })
        : dlCounter
          ? t('statusBar.cloudDownloadingCount', {
            defaultValue: 'Downloading {{name}} ({{counter}})',
            name: jobName,
            counter: dlCounter,
          })
          : t('statusBar.cloudDownloading', {
            defaultValue: 'Downloading {{name}}…',
            name: jobName,
          });
    const dlLabel = extraActiveCount > 0
      ? `${dlLabelBase} ${t('statusBar.cloudDownloadMore', { defaultValue: '+{{count}}', count: extraActiveCount })}`
      : dlLabelBase;
    const dlTooltip = [
      t('statusBar.cloudDownloadTooltipRunning', {
        defaultValue: 'Downloading {{name}} in the background. Click to view progress or cancel.',
        name: jobName,
      }),
      dlProgress?.current_path
        ? t('statusBar.cloudTooltipCurrent', {
          defaultValue: 'Now: {{action}} {{path}}',
          action: dlProgress.current_action || 'download',
          path: dlProgress.current_path,
        })
        : null,
    ].filter(Boolean).join('\n');

    downloadIndicator = (
      <button
        type="button"
        className="vscode-statusbar-item"
        onClick={onOpenCloudDownload}
        title={dlTooltip}
        aria-label={dlTooltip}
      >
        <RefreshCw size={12} className="animate-spin" />
        <span>{dlLabel}</span>
      </button>
    );
  } else if (failedDownload) {
    const jobName = failedDownload.folder_name || failedDownload.remote_name;
    const dlTooltip = [
      t('statusBar.cloudDownloadTooltipFailed', {
        defaultValue: 'Download of {{name}} failed. Click to view details.',
        name: jobName,
      }),
      failedDownload.error || null,
    ].filter(Boolean).join('\n');
    downloadIndicator = (
      <span className="flex items-center" style={{ gap: '2px' }}>
        <button
          type="button"
          className="vscode-statusbar-item"
          onClick={onOpenCloudDownload}
          title={dlTooltip}
          aria-label={dlTooltip}
        >
          <AlertTriangle size={12} style={{ color: 'var(--vscode-fg-warning)' }} />
          <span>{t('statusBar.cloudDownloadFailed', { defaultValue: 'Download failed: {{name}}', name: jobName })}</span>
        </button>
        <button
          type="button"
          className="vscode-statusbar-item"
          onClick={() => onDismissCloudDownload?.(failedDownload.id)}
          title={t('cloudDownload.dismiss', 'Dismiss')}
          aria-label={t('cloudDownload.dismiss', 'Dismiss')}
          style={{ padding: '2px 4px' }}
        >
          <X size={11} />
        </button>
      </span>
    );
  } else if (completedDownload) {
    const jobName = completedDownload.project?.project_name || completedDownload.folder_name || completedDownload.remote_name;
    const chatsImportError = completedDownload.project?.chats_import_error || '';
    const dlTooltip = [
      t('statusBar.cloudDownloadTooltipDone', {
        defaultValue: '{{name}} finished downloading. Click to open this project.',
        name: jobName,
      }),
      chatsImportError
        ? t('cloudDownload.chatsImportFailed', {
          error: chatsImportError,
          defaultValue: 'The conversations could not be imported: {{error}}. The conversation files are still in the project folder.',
        })
        : null,
    ].filter(Boolean).join('\n');
    downloadIndicator = (
      <span className="flex items-center" style={{ gap: '2px' }}>
        <button
          type="button"
          className="vscode-statusbar-item"
          onClick={() => onOpenDownloadedProject?.(completedDownload)}
          title={dlTooltip}
          aria-label={dlTooltip}
        >
          <CloudDownload size={12} />
          {chatsImportError
            ? <AlertTriangle size={11} style={{ color: 'var(--vscode-fg-warning)' }} />
            : <Check size={11} />}
          <span>{t('statusBar.cloudDownloadDone', { defaultValue: 'Downloaded {{name}} — Open', name: jobName })}</span>
        </button>
        <button
          type="button"
          className="vscode-statusbar-item"
          onClick={() => onDismissCloudDownload?.(completedDownload.id)}
          title={t('cloudDownload.dismiss', 'Dismiss')}
          aria-label={t('cloudDownload.dismiss', 'Dismiss')}
          style={{ padding: '2px 4px' }}
        >
          <X size={11} />
        </button>
      </span>
    );
  }

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
        {cloudStatus?.settings?.enabled && (
          <button
            type="button"
            className="vscode-statusbar-item"
            onClick={onOpenCloudSync}
            title={cloudTooltip}
            aria-label={cloudTooltip}
          >
            {cloudIcon}
            <span>{cloudLabel}</span>
          </button>
        )}
        {downloadIndicator}
      </div>

      <div className="flex items-center" style={{ gap: '12px' }}>
        {textStats && (
          <button
            type="button"
            className="vscode-statusbar-item"
            onClick={textStats.onCycleMode}
            title={countTooltip}
            aria-label={countTooltip}
          >
            <CaseSensitive size={12} />
            <span>
              {textStats.selection
                ? t('statusBar.countSelection', {
                  words: formatNumber(shownStats.words),
                  characters: formatNumber(shownStats.characters),
                })
                : t('statusBar.count', {
                  words: formatNumber(shownStats.words),
                  characters: formatNumber(shownStats.characters),
                })}
            </span>
            <span style={{ opacity: 0.85 }}>{modeLabel}</span>
          </button>
        )}
        <span>UTF-8</span>
        <span>LF</span>
        <span>JSON IPC Bridge</span>
      </div>
    </footer>
  );
}
