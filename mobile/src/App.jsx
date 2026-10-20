import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { detectLanguage } from './i18n';
import { createServices } from './services.js';
import { loadSettings, saveSettings } from './project/settings.js';
import { createProjectSession } from './project/session.js';
import SignIn from './ui/SignIn.jsx';
import ProjectList from './ui/ProjectList.jsx';
import ProjectView from './ui/ProjectView.jsx';
import Settings from './ui/Settings.jsx';

export default function App() {
  const { t } = useTranslation();
  const services = useMemo(() => createServices(), []);
  const [settings, setSettings] = useState(null);
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [project, setProject] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // One session per project for the life of the app: leaving a project and
  // coming back must not throw away what was already read from Drive.
  const sessions = useRef(new Map());

  const sessionFor = useCallback((target) => {
    if (!sessions.current.has(target.root)) {
      sessions.current.set(target.root, createProjectSession({
        drive: services.drive, kv: services.kv, device: settings.device, project: target,
      }));
    }
    return sessions.current.get(target.root);
  }, [services, settings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadSettings(services.kv);
      if (cancelled) return;
      setSettings(loaded);
      i18n.changeLanguage(detectLanguage(loaded.language));
      // A grant that still stands yields a token without any UI; anything else
      // means the user has to press Connect.
      if (await services.kv.get('signedIn')) {
        try {
          await services.auth.getToken();
          if (!cancelled) setSignedIn(true);
        } catch {
          // fall through to the sign-in screen
        }
      }
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [services]);

  const updateSettings = useCallback(async (next) => {
    setSettings(next);
    await saveSettings(services.kv, next);
    i18n.changeLanguage(detectLanguage(next.language));
  }, [services]);

  const onSignedIn = useCallback(async () => {
    await services.kv.set('signedIn', true);
    setSignedIn(true);
  }, [services]);

  const onSignOut = useCallback(async () => {
    await services.auth.signOut().catch(() => {});
    await services.kv.delete('signedIn');
    sessions.current.clear();
    setProject(null);
    setShowSettings(false);
    setSignedIn(false);
  }, [services]);

  if (checking || !settings) {
    return <div className="screen center"><p className="muted">{t('app.loading')}</p></div>;
  }
  if (!signedIn) return <SignIn services={services} onSignedIn={onSignedIn} />;

  // Settings opens over the current screen instead of replacing it, so the
  // project (or the project list) underneath keeps its state and is not
  // rebuilt — and re-synced from nothing — when Settings closes.
  return (
    <>
      <div className="layer" hidden={showSettings}>
        {project ? (
          <ProjectView
            key={project.root}
            services={services}
            settings={settings}
            project={project}
            session={sessionFor(project)}
            onBack={() => setProject(null)}
            onOpenSettings={() => setShowSettings(true)}
            onSettingsChange={updateSettings}
          />
        ) : (
          <ProjectList services={services} offlineProjects={settings.offlineProjects} onOpen={setProject} onOpenSettings={() => setShowSettings(true)} />
        )}
      </div>
      {showSettings && (
        <div className="layer">
          <Settings
            services={services}
            settings={settings}
            onChange={updateSettings}
            onClose={() => setShowSettings(false)}
            onSignOut={onSignOut}
          />
        </div>
      )}
    </>
  );
}
