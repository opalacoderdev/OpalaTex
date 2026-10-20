import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

export function detectLanguage(preferred = '') {
  if (preferred) return preferred;
  const nav = (globalThis.navigator?.language || 'en').toLowerCase();
  return nav.startsWith('pt') ? 'pt-BR' : 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    'pt-BR': { translation: ptBR },
    pt: { translation: ptBR },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  initImmediate: false,
  interpolation: { escapeValue: false },
});

export default i18n;
