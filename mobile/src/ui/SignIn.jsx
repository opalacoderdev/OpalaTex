import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function SignIn({ services, onSignedIn }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devToken, setDevToken] = useState('');
  const [hint, setHint] = useState('');
  const [identity, setIdentity] = useState(null);

  const connect = async () => {
    setBusy(true);
    setError('');
    setHint('');
    try {
      await services.auth.authorize();
      await onSignedIn();
    } catch (err) {
      setError(t('signIn.failed', { message: err?.message || String(err) }));
      if (services.native) {
        // The plugin rejects with Google's status number as the code.
        const known = ['10', '16', '7'];
        setHint(t(known.includes(String(err?.code)) ? `signIn.hint${err.code}` : 'signIn.hintOther'));
        services.plugin.appIdentity().then(setIdentity).catch(() => setIdentity(null));
      }
    } finally {
      setBusy(false);
    }
  };

  const useDevToken = async () => {
    await services.plugin.setDevelopmentToken({ token: devToken.trim() });
    await connect();
  };

  return (
    <div className="screen center sign-in">
      <img src="./icon.png" alt="" className="brand-icon" />
      <h1>{t('signIn.title')}</h1>
      <p className="muted">{t('signIn.body')}</p>
      {services.native ? (
        <button type="button" className="primary wide" onClick={connect} disabled={busy}>
          {busy ? t('signIn.connecting') : t('signIn.connect')}
        </button>
      ) : (
        <div className="card dev-card">
          <h2>{t('signIn.devTitle')}</h2>
          <p className="muted small">{t('signIn.devBody')}</p>
          <label className="field">
            <span>{t('signIn.devToken')}</span>
            <input value={devToken} onChange={(event) => setDevToken(event.target.value)} autoComplete="off" />
          </label>
          <button type="button" className="primary wide" onClick={useDevToken} disabled={busy || !devToken.trim()}>
            {t('signIn.devUse')}
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {hint && <p className="muted small">{hint}</p>}
      {identity && (
        <p className="small identity">
          {t('signIn.identity', { packageName: identity.packageName, sha1: (identity.sha1 || []).join(', ') })}
        </p>
      )}
    </div>
  );
}
