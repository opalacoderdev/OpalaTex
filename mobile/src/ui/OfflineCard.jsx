import React from 'react';
import { useTranslation } from 'react-i18next';
import { CloudDownload } from 'lucide-react';

export function formatBytes(bytes, language) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** The "available offline" switch of a project, with what it has saved. */
export default function OfflineCard({ enabled, state, onToggle }) {
  const { t, i18n } = useTranslation();
  const { status, progress, error } = state;
  let detail = t('offline.off');
  if (enabled && progress) {
    detail = t('offline.saving', { done: progress.done, total: progress.total });
  } else if (enabled && status) {
    detail = t('offline.saved', { saved: status.saved, total: status.total, size: formatBytes(status.bytes, i18n.language) });
  }
  return (
    <div className="card offline-card">
      <label className="offline-toggle">
        <CloudDownload size={20} className="row-icon" />
        <span className="row-main">
          <span className="row-title">{t('offline.title')}</span>
          <span className="row-sub">{detail}</span>
        </span>
        <input type="checkbox" role="switch" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      {enabled && status?.skipped > 0 && <span className="muted small">{t('offline.skipped', { count: status.skipped })}</span>}
      {enabled && error && <span className="error small">{t('offline.failed', { message: error })}</span>}
    </div>
  );
}
