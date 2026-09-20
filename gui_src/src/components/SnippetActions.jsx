import React from 'react';
import { MessageSquareQuote, Languages, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The context-menu actions that apply to any document excerpt: ask the agent
 * about it, translate it, hear it.
 *
 * One owner, rendered by every document menu. The PDF viewer had these items
 * written inline; copying them into the Markdown preview's menu would have
 * meant two label tables, two disabled-state rules and two places to add the
 * next action to.
 *
 * Everything here is i18n-only — no hardcoded user-facing string — and each
 * item states *why* it is unavailable rather than doing nothing when pressed.
 */
export default function SnippetActions({
  hasSelection,
  canAsk = true,
  onAskAbout,
  onTranslate,
  onPronounce,
  canPronounce = false,
  pronounceUnavailableHint = '',
}) {
  const { t } = useTranslation();

  const needsSelection = t('snippetActions.needsSelection', 'Select some text first.');

  return (
    <>
      <div
        className={`vscode-context-menu-item${canAsk ? '' : ' vscode-context-menu-item-disabled'}`}
        role="menuitem"
        aria-disabled={!canAsk}
        onClick={() => { if (canAsk) onAskAbout(); }}
      >
        <MessageSquareQuote size={13} style={{ color: '#007acc' }} />
        <span>
          {hasSelection
            ? t('snippetActions.askAboutSelection', 'Ask about the selected excerpt')
            : t('snippetActions.askAboutDocument', 'Ask about this document')}
        </span>
      </div>

      <div
        className={`vscode-context-menu-item${hasSelection ? '' : ' vscode-context-menu-item-disabled'}`}
        role="menuitem"
        aria-disabled={!hasSelection}
        title={hasSelection ? undefined : needsSelection}
        onClick={() => { if (hasSelection) onTranslate(); }}
      >
        <Languages size={13} style={{ color: 'var(--vscode-fg-link)' }} />
        <span>{t('snippetActions.translate', 'Translate selection')}</span>
      </div>

      {onPronounce && (
        <div
          className={`vscode-context-menu-item${hasSelection && canPronounce ? '' : ' vscode-context-menu-item-disabled'}`}
          role="menuitem"
          aria-disabled={!hasSelection || !canPronounce}
          title={
            !hasSelection
              ? needsSelection
              : (canPronounce ? undefined : pronounceUnavailableHint)
          }
          onClick={() => { if (hasSelection && canPronounce) onPronounce(); }}
        >
          <Volume2 size={13} style={{ color: 'var(--vscode-fg-link)' }} />
          <span>{t('snippetActions.pronounce', 'Pronounce selection')}</span>
        </div>
      )}
    </>
  );
}
