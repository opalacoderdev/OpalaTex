// Opening a coding agent's CLI (Claude Code, Antigravity CLI) in a terminal tab,
// connected to OpalaTex through `opalatex mcp` (opalatex/agent_clis.py,
// docs/specs/external_agents.md, phase 3).
//
// Everything the user is asked happens here, before anything changes:
// turning external agent access on, and -- for Antigravity CLI, which has no
// per-session MCP option -- registering the server in its user configuration.
// Saying no to either leaves everything as it was.

import { EXTERNAL_ACCESS_CHANGED_EVENT, EXTERNAL_ACCESS_SETTINGS_PATH } from './windowCommandChannel.js';

export const AGENT_CLIS_PATH = '/api/external-agents/clis';
export const AGENT_LAUNCH_PATH = '/api/external-agents/launch';

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload };
}

/**
 * The warning shown to a user of the snap package where external agent
 * access is turned on (Settings) or about to be (the launch below). The
 * snap's confinement hides the folders where the agent CLIs install
 * themselves, so they may not work there (docs/specs/external_agents.md).
 */
export function snapWarning(t) {
  return t('externalAgents.snapWarning', 'OpalaTex is running as a snap. Its confinement hides the hidden folders of your home (such as ~/.local/bin, ~/.claude and ~/.gemini), where Claude Code and Antigravity CLI install themselves, so external agents may not work: the agent button may not find them, and an agent started outside OpalaTex may fail to connect. To use external agents, install OpalaTex from the .deb package or with install.sh.');
}

/**
 * Run the whole launch. Resolves to `{ ok: true, termId, label }` once the CLI
 * was typed into a new tab, `{ ok: false, cancelled: true }` when the user
 * declined a question, or `{ ok: false, error }`.
 *
 * deps: fetchImpl, confirm(message, title, options) -> Promise<boolean>,
 *       t(key, default, values), notify(enabled) when the access changed.
 */
export async function launchAgentInTerminal({ agent, projectPath, termId }, deps) {
  const { fetchImpl, confirm, t } = deps;

  const settings = await fetchImpl(EXTERNAL_ACCESS_SETTINGS_PATH).then((r) => r.json()).catch(() => null);
  if (!settings) return { ok: false, error: t('agentLauncher.settingsUnreadable', 'Could not read the external agent setting.') };
  if (!settings.enabled) {
    const question = t('agentLauncher.enableAccess', 'Opening {{agent}} connected to OpalaTex turns on external agent access: coding agents on this computer will be able to open and close tabs, change the layout and read the window, and compile the document after you approve each compile in this window. You can turn it off in Settings > External agents. Turn it on?', { agent: agent.label });
    const agree = await confirm(
      settings.snap === true ? `${snapWarning(t)}\n\n${question}` : question,
      t('agentLauncher.enableAccessTitle', 'External agent access'),
      { okLabel: t('agentLauncher.turnOn', 'Turn on') },
    );
    if (!agree) return { ok: false, cancelled: true };
    const enabled = await postJson(fetchImpl, EXTERNAL_ACCESS_SETTINGS_PATH, { enabled: true });
    if (!enabled.ok || enabled.payload.enabled !== true) {
      return { ok: false, error: enabled.payload.error || t('agentLauncher.enableFailed', 'Could not turn on external agent access.') };
    }
    deps.notify?.(true);
  }

  const request = { agent: agent.id, projectPath, term_id: termId };
  let launched = await postJson(fetchImpl, AGENT_LAUNCH_PATH, request);
  if (launched.status === 409 && launched.payload.code === 'needs_registration') {
    const { payload } = launched;
    const agree = await confirm(
      t('agentLauncher.register', '{{agent}} has no per-session MCP setting, so OpalaTex must register its server once in {{agent}}\'s user configuration ({{path}}), by running:\n\n{{command}}\n\nIt then applies to every {{agent}} session; in a folder that is not a project open in OpalaTex, the server does not start and says why. Register it?', {
        agent: agent.label,
        path: payload.config_path,
        command: payload.command_line,
      }) + (payload.registration === 'different'
        ? `\n\n${t('agentLauncher.replaces', 'This replaces the existing "opalatex" entry.')}`
        : ''),
      t('agentLauncher.registerTitle', 'Register OpalaTex in {{agent}}', { agent: agent.label }),
      { okLabel: t('agentLauncher.registerOk', 'Register') },
    );
    if (!agree) return { ok: false, cancelled: true };
    launched = await postJson(fetchImpl, AGENT_LAUNCH_PATH, { ...request, register: true });
  }
  if (!launched.ok) {
    return { ok: false, error: launched.payload.error || `HTTP ${launched.status}`, code: launched.payload.code };
  }
  return { ok: true, termId, label: launched.payload.label || agent.label };
}

/** Announce a change of the access setting to the window (useWindowCommandChannel). */
export function announceExternalAccess(enabled) {
  window.dispatchEvent(new CustomEvent(EXTERNAL_ACCESS_CHANGED_EVENT, { detail: { enabled } }));
}
