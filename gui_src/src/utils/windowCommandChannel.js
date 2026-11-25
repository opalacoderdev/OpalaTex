// The window's command stream for agents outside OpalaTex
// (docs/specs/external_agents.md, opalatex/ide_control.py WindowBus).
//
// The built-in agent's commands arrive on its turn's stream. An external agent
// calls when no turn is running, so while external agent access is on the
// window keeps this stream open, and its commands are carried out by the same
// runner a click uses (ideCommands.js) and answered through the same endpoint.

export const WINDOW_COMMAND_STREAM_PATH = '/api/ide/window/stream';
export const EXTERNAL_ACCESS_SETTINGS_PATH = '/api/settings/external-access';
// Fired on `window` by the settings dialog when the user turns the access on or off.
export const EXTERNAL_ACCESS_CHANGED_EVENT = 'opalatex:external-access-changed';

export function newWindowId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function windowCommandStreamUrl(windowId, projectPath) {
  const query = new URLSearchParams({ windowId: String(windowId), projectPath: String(projectPath) });
  return `${WINDOW_COMMAND_STREAM_PATH}?${query.toString()}`;
}

/**
 * Open the stream and hand every command to `onCommand`. Returns the function
 * that closes it. A payload that is not JSON is reported to `onError` and
 * skipped; the server never sends one, so it means a broken proxy or build.
 */
export function connectWindowCommandChannel({ windowId, projectPath, onCommand, onEvent, onError, EventSourceImpl }) {
  const Impl = EventSourceImpl || globalThis.EventSource;
  const source = new Impl(windowCommandStreamUrl(windowId, projectPath));
  const listen = (name, handler) => source.addEventListener(name, (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      onError?.(err);
      return;
    }
    handler?.(data);
  });
  // Commands are answered (answerIdeCommand); events, such as latex_compiled,
  // are only shown -- as the same events on a built-in agent's turn stream are.
  listen('ide_command', onCommand);
  listen('ide_event', onEvent);
  return () => source.close();
}

/**
 * Carry out one command with `runner` and post the outcome, refusals included,
 * so the caller fails with the window's reason instead of a timeout.
 */
export async function answerIdeCommand(command, { runner, post }) {
  let result;
  try {
    result = await runner(command);
  } catch (err) {
    result = { ok: false, error: `The IDE failed to carry out '${command?.action}': ${err?.message || err}` };
  }
  await post({ ...result, id: command?.id });
  return result;
}

// ── Registering the MCP server in an agent ──────────────────────────────────

function looksLikeWindowsPath(value) {
  // A drive letter or a UNC share; a backslash alone is a legal POSIX file name character.
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function quoteArg(arg, windows) {
  const value = String(arg);
  // A backslash is a path separator on Windows and an escape in a POSIX shell.
  const plain = windows ? /^[A-Za-z0-9_./:@%+=,\\-]+$/ : /^[A-Za-z0-9_./:@%+=,-]+$/;
  if (value && plain.test(value)) return value;
  if (windows) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `argv` as one line to paste in a shell: POSIX quoting, or Windows' when the program is a Windows path. */
export function formatCommandLine(argv) {
  const args = (argv || []).map(String);
  const windows = args.length > 0 && looksLikeWindowsPath(args[0]);
  return args.map((arg) => quoteArg(arg, windows)).join(' ');
}

/** The commands that register `opalatex mcp` (its argv: `mcpCommand`) in each supported agent. */
export function agentRegistrationCommands(mcpCommand) {
  const command = formatCommandLine(mcpCommand);
  return {
    claude: `claude mcp add opalatex -- ${command}`,
    antigravity: `agy mcp add opalatex ${command}`,
  };
}
