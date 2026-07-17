import { useTranslation } from '../../i18n';
import type { AgentPanelOptions } from './types';

/**
 * Inner wrapper that calls `useTranslation` to forward localised labels
 * down to AgentPanel. Lives below the LocaleProvider so the context is
 * resolved.
 */
export function LocalizedAgentPanel({
  agentPanel,
  closed,
  onClose,
}: {
  agentPanel: AgentPanelOptions;
  closed: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={agentPanel.title ?? t('agentPanel.defaultTitle')}
      style={{
        display: closed ? 'none' : 'flex',
        flexDirection: 'column',
        width: agentPanel.defaultWidth ?? 360,
        minWidth: agentPanel.minWidth ?? 260,
        maxWidth: agentPanel.maxWidth ?? 520,
        borderLeft: '1px solid var(--doc-border)',
        background: 'var(--doc-surface)',
        color: 'var(--doc-text)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--doc-border)',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {agentPanel.icon}
          {agentPanel.title ?? t('agentPanel.defaultTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('agentPanel.close')}
          style={{
            border: '1px solid var(--doc-border)',
            background: 'var(--doc-bg-subtle)',
            color: 'var(--doc-text)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
            padding: '2px 7px',
          }}
        >
          x
        </button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {agentPanel.render({ close: onClose })}
      </div>
    </aside>
  );
}
