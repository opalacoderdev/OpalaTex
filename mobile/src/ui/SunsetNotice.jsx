import React from 'react';
import { useTranslation } from 'react-i18next';
import { SUCCESSOR_NAME, SUCCESSOR_URL } from '../successor.js';

// This is the final OpalaTex version. Shown on the project list and in Settings.
// `inset` drops the side margin where the container already pads its content.
export default function SunsetNotice({ inset = false }) {
  const { t } = useTranslation();
  return (
    <div className="notice notice-action" role="note" style={inset ? { margin: '0 0 16px' } : undefined}>
      <strong>{t('sunset.title', { name: SUCCESSOR_NAME })}</strong>
      <span>{t('sunset.body', { name: SUCCESSOR_NAME })}</span>
      <a href={SUCCESSOR_URL} target="_blank" rel="noreferrer noopener">{t('sunset.open', { name: SUCCESSOR_NAME })}</a>
    </div>
  );
}
