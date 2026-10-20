import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudDownload, Folder, RefreshCw, Settings as SettingsIcon } from 'lucide-react';

export default function ProjectList({ services, offlineProjects = {}, onOpen, onOpenSettings }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const listed = await services.drive.listProjects();
      setProjects(listed);
      await services.kv.set('projects', listed);
    } catch (err) {
      const cached = await services.kv.get('projects');
      if (cached) setProjects(cached);
      setError(t('projects.loadFailed', { message: err?.message || String(err) }));
    } finally {
      setLoading(false);
    }
  }, [services, t]);

  useEffect(() => {
    // The last list this device saw is shown at once; the refresh replaces it.
    let cancelled = false;
    services.kv.get('projects')
      .then((cached) => { if (cached && !cancelled) setProjects((current) => current || cached); })
      .catch(() => {});
    load();
    return () => { cancelled = true; };
  }, [load, services]);

  return (
    <div className="screen">
      <header className="bar">
        <h1>{t('projects.title')}</h1>
        <div className="bar-actions">
          <button type="button" className="icon" onClick={load} aria-label={t('projects.refresh')} disabled={loading}>
            <RefreshCw size={20} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" className="icon" onClick={onOpenSettings} aria-label={t('projects.settings')}>
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>
      <main className="scroll">
        {error && <p className="error banner" role="alert">{error}</p>}
        {projects === null && !error && <p className="muted pad">{t('app.loading')}</p>}
        {projects && projects.length === 0 && (
          <div className="pad">
            <p>{t('projects.empty')}</p>
            <p className="muted small">{t('projects.emptyHint')}</p>
          </div>
        )}
        <ul className="list">
          {(projects || []).map((project) => (
            <li key={project.root}>
              <button type="button" className="row" onClick={() => onOpen(project)}>
                <Folder size={20} className="row-icon" />
                <span className="row-main">
                  <span className="row-title">{project.name}</span>
                  {project.modifiedTime && (
                    <span className="row-sub">{new Date(project.modifiedTime).toLocaleString()}</span>
                  )}
                </span>
                {offlineProjects[project.root] && (
                  <span className="badge" title={t('offline.title')}><CloudDownload size={14} /> {t('projects.offlineBadge')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
