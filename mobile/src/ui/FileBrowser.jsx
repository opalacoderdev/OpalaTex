import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText, Folder } from 'lucide-react';
import FileViewer from './FileViewer.jsx';

/**
 * Folders and files of the project, one level at a time. `version` changes
 * whenever the project was re-read; the listing follows it.
 */
export default function FileBrowser({ workspace, version, onAsk, header = null }) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState(null);
  const [dir, setDir] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // Only once there is an index: listing before it would make the workspace
    // walk Drive on its own, in parallel with the sync that is already doing so.
    if (!workspace.index) return undefined;
    workspace.listPaths()
      .then((list) => { if (!cancelled) setPaths(list); })
      .catch(() => { if (!cancelled) setPaths((current) => current || []); });
    return () => { cancelled = true; };
  }, [workspace, version]);

  const entries = useMemo(() => {
    const prefix = dir ? `${dir}/` : '';
    const folders = new Set();
    const files = [];
    for (const path of paths || []) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) folders.add(rest.slice(0, slash));
      else files.push(rest);
    }
    return { folders: [...folders].sort(), files: files.sort() };
  }, [paths, dir]);

  if (open) return <FileViewer workspace={workspace} path={open} onClose={() => setOpen(null)} onAsk={onAsk} />;
  if (!paths) return <>{header}<p className="muted pad">{t('app.loading')}</p></>;

  return (
    <>
      {!dir && header}
      {dir && (
        <button type="button" className="row crumb" onClick={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')}>
          <ArrowLeft size={18} className="row-icon" /><span className="row-title">{dir}</span>
        </button>
      )}
      {!entries.folders.length && !entries.files.length && <p className="muted pad">{t('files.empty')}</p>}
      <ul className="list">
        {entries.folders.map((name) => (
          <li key={`d:${name}`}>
            <button type="button" className="row" onClick={() => setDir(dir ? `${dir}/${name}` : name)}>
              <Folder size={20} className="row-icon" /><span className="row-title">{name}</span>
            </button>
          </li>
        ))}
        {entries.files.map((name) => (
          <li key={`f:${name}`}>
            <button type="button" className="row" onClick={() => setOpen(dir ? `${dir}/${name}` : name)}>
              <FileText size={20} className="row-icon" /><span className="row-title">{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
