# External agents over MCP — decisions and current state

Status: **phases 1–3 implemented, phase 4 in part**: window command
channel, discovery file and token, the stdio MCP server `opalatex mcp`, the
token-authenticated external endpoints, the settings section, the "open in
terminal" button, the live `get_window_state`, and the approval of external
calls with `compile_latex` as the first tool that needs it. Verified by
`tests/test_external_access.py`, `tests/test_external_agents_mcp.py` (end to
end with the MCP SDK's own client starting `opalatex mcp` over stdio,
including an approved compile), `tests/test_agent_clis.py`,
`tests/test_agenticblocks_mcp_server.py`, and **by hand with Claude Code in
the desktop window on Ubuntu (2026-11-24)**: `claude --mcp-config` /
`claude mcp add`, tools listed, a file opened and the layout changed; then the
"open in terminal" button. Since 2026-11-25, also checkpoints of Claude
Code's turns (`opalatex/external_turns.py`, `opalatex agent-hook`,
`tests/test_external_turns.py`, end to end with the real command against a
running server). **Not yet verified**: the approval dialog in the window,
Claude Code actually running the hooks of the button's `--settings` file,
`agy` as a client, Windows, macOS -- see *Open items*. The snap is not
supported (see *Open items*).
The architecture section is §2.34 of [PROJECT_DESIGN.md](../../PROJECT_DESIGN.md).

## Goal

Coding agents that run in a terminal (Claude Code, Antigravity CLI `agy`, any
MCP client) connect to a running OpalaTex **as MCP clients** and drive it: open
and close tabs, change the layout, reveal a line in the PDF, read the Problems
panel and, later, the rest of the interface. "Integrate" does not mean running
the CLI in an OpalaTex terminal tab and nothing else: the CLI talks to OpalaTex
through an MCP server OpalaTex exposes. A button that opens the CLI in the
IDE's terminal already connected to that server is a convenience on top
(phase 3), not the integration itself.

## Scope decisions

| Question | Decision |
| --- | --- |
| Who is affected when nobody uses it | Nobody. The feature is **off by default** (`<opalatex home>/external_access.json`, `enabled: false`). Off, the window opens no extra stream, no discovery file is written, no token exists outside the process, and the MCP SDK's server side is never imported. The built-in agent keeps the channel it uses today. |
| How the built-in agent's tools reach the window | Unchanged: an `ide_command` event on the turn's own stream (`ide_control.send_ide_command`, default channel). |
| How an external agent's command reaches the window | A **window command channel**: a stream the window keeps open while external access is on (`GET /api/ide/window/stream`), independent of any agent turn, because an external agent calls when no turn is running. Commands go through the same runner a click uses (`gui_src/src/utils/ideCommands.js`) and are answered through the same endpoint (`/api/opalatex/ide_command_result`). The channel is chosen explicitly by the caller (`ide_control.use_command_channel`); `send_ide_command` never falls back from one channel to the other. |
| Which window answers | The one whose open project is the command's project (paths compared after normalisation, case-insensitively on Windows). None open on that project: the command fails at once with that diagnostic. Several: the most recently connected one. |
| A window that disconnects while a command waits | The command fails at once ("the window disconnected"), not after the 15 s timeout. |
| How a CLI finds the running OpalaTex | A **discovery file** per running instance, `<opalatex home>/external_access/instances/<port>.json`: format tag, pid, URL, token, start time. Directory `0700`, file `0600`, written atomically. Written when external access is on (at start, or when the user turns it on), removed when it is turned off and when the server stops. The port changes between launches (`find_available_port`), so a CLI never stores it; a reader skips files whose pid is no longer alive. |
| How a CLI authenticates | A bearer token, random per process (`secrets.token_urlsafe(32)`), **distinct from the window's session cookie**. The cookie keeps meaning "the window" and is never written to disk; the token will be accepted only by the external endpoints (phase 2), never by the window's `/api/*`. |
| How the CLI connects (phase 2) | A stdio MCP server, `opalatex mcp`, that the CLI starts as a child process. It reads the discovery file, picks the instance whose window has the CLI's working directory open (or the only instance), and forwards each tool call to that instance over loopback HTTP with the token. Stdio, because both Claude Code and `agy` support it and the configuration stays constant across launches (no port, no token in the CLI's config). |
| Where the generic MCP server code lives (phase 2) | `agenticblocks/tools/mcp_server.py` (rule 2): a server that exposes a list of tool specs and a call handler over stdio, useful outside OpalaTex. The OpalaTex catalog and the forwarding stay in `opalatex/`. |
| Which tools are exposed | The built-in agent's own Blocks, so schema, validation and messages have one definition: the IDE control tools (`open_file`, `close_file`, `reveal_in_pdf`, `set_layout`, `get_problems`, `read_terminal`), plus `get_window_state`. They are all `is_safe`. Tools that change files or run things come later, behind the same permission gate the built-in agent uses, approved in the window. |
| `get_editor_state` | **Not exposed.** It reads what the window staged at the start of the built-in agent's turn, which says nothing current to a caller outside any turn. External agents get **`get_window_state`** instead: a live window command (`get_editor_state` in `ideCommands.js`) answering tabs, focused file, unsaved flag, Monaco cursor and selection, and the live buffer on request (each capped at 100,000 characters). It is not in the built-in agent's tool list, which is unchanged. |
| Opening an agent from the window | A bot button beside the terminal panel's "+" lists Claude Code and Antigravity CLI, each found or not. Choosing one opens a new tab (`main-N`, counted in the panel's limit of 3) in the project and types the CLI's command there; the tab is added only once the shell exists, so its stream attaches to that shell. With the access off, the user is asked to turn it on first; declining changes nothing. Closing an agent's tab ends its session (`/api/terminal/temp/kill`); plain shell tabs keep their existing behaviour. |
| Finding the CLI | On the `PATH` of the terminal's own shell (an interactive `/bin/bash`, asked for its `PATH`; the process's `PATH` on Windows), not the window process's, which a desktop launch lacks `~/.local/bin` and the like on. Not found: the button says so and that the command must run in a new terminal; inside a snap it adds that the confinement may hide hidden home folders. |
| Claude Code's configuration | Per session: `claude --mcp-config <opalatex home>/external_access/claude-mcp.json`, a file OpalaTex writes (the command only, no secret). Nothing is written into Claude Code's configuration. If the user also registered `opalatex` there from Settings, both name the same command. |
| Antigravity's configuration | `agy --settings` rejects `mcpServers` (verified), so the server is registered once in agy's user configuration, by running `agy mcp add opalatex -- <command>` -- agy's own command, never an edit of its file -- **only after the user agreed** in a dialog that names the file and the command, and says that it replaces an existing `opalatex` entry when there is one. The registration is checked against the file afterwards. An entry that is disabled or names another command counts as not registered. |
| Which project a call acts on | The call's own (`tools.project_path_for_call`, a context variable read by `get_project_path`), never the module globals a running turn has bound. The project must be open in a window that listens for external commands; otherwise the call is refused before any tool runs. |
| Where `opalatex mcp` sends a call | To the instance whose window has the innermost project containing the CLI's working directory (or `--project`). Resolved at start; with no instance or no such project, the server exits with what to do on stderr. An instance that stops answering mid-session is looked up again once (same project, same request); otherwise the call is a tool error. |
| How the user registers the server | Settings > External agents shows, once the access is on, the exact `claude mcp add opalatex -- <command>` and `agy mcp add opalatex <command>` lines for this installation (`external_access.mcp_command`: the frozen executable, `main.py` of a checkout, `-m opalatex.cli`, or `/snap/bin/<snap>`; never `pythonw.exe`, which may have no stdio). The user runs them; OpalaTex writes nothing into an agent's configuration. |
| Commands that do not need the window | Not in phase 1/2. The external agent already edits files itself; the value is what only OpalaTex has (the window, Tectonic + SyncTeX, Problems, chats). |
| Approval of an external call | A tool that is not safe (`tools.TOOL_SAFETY`, from each `opalatex_tool`'s `is_safe`) runs for an external agent only after the user approved it **in the OpalaTex window**, whatever the external agent's own permission settings (OpalaTex cannot see them; `--dangerously-skip-permissions` exists). The dialog is the built-in agent's `ConfirmModal` (Yes / No / Always Allow), in a state of its own so it never replaces a question of the built-in agent, naming the tool and its arguments and saying it comes from an external agent. Arguments are validated first, so an invalid call is never put to the user. |
| What the chat's mode means for an external call | Nothing. Plan/edit/auto and the remembered answers (`_DENIED_TOOLS`, `allowed_tools`) belong to the built-in agent's turn; an external call neither reads nor changes them (`tools.external_call_approved`, a context variable the permission wrapper reads first; unset for the built-in agent). |
| "Always Allow" | Per tool and project, in memory, until external access is turned off or the application restarts. "No" is not remembered: the next call asks again. |
| An unanswered approval | A refusal. The dialog closes itself after 5 minutes (`APPROVAL_TIMEOUT`) and the call fails with "did not approve"; requests wait one at a time, in order. `opalatex mcp` waits up to 30 minutes for a call (an approval and a first compile). |
| An external compile | `compile_latex` itself (Tectonic, the same messages); its `latex_compiled` event goes to the window's own stream (`ide_control.publish_ide_event`, through the call's channel, from the tool's worker thread), so the PDF pane reloads and Problems fills as for the built-in agent. The main file is the one stored for the call's project (`project.stored_main_file`, what the Compile button reads), not the built-in agent's last session's. |
| Checkpoints of an external agent's turns | Only where the agent runs a command at each turn boundary and OpalaTex starts the session: **Claude Code opened from the bot button**. Its `--settings` file (`<opalatex home>/external_access/claude-settings.json`, `agent_clis.claude_hook_settings`, for that session only, merged by Claude Code with the user's own hooks) runs `opalatex agent-hook turn-start` on `UserPromptSubmit`, `turn-end` on `Stop` and `session-end` on `SessionEnd`. The command reads the hook's JSON (`session_id`, `cwd`; `CLAUDE_PROJECT_DIR` first), finds the instance as `opalatex mcp` does and posts `POST /api/external/turn` with the token. `external_turns.ExternalTurns` keeps one `vcs.AsyncAgentTurnCheckpoint` open per (project, session), labelled "Claude Code", and on its end publishes `checkpoint_finalized` to the window's stream (Review refreshes, open tabs of the changed files reload). Review shows the label next to "Agent checkpoint". |
| An interrupted external turn | Claude Code runs no `Stop` hook when the user interrupts; the next `turn-start` of the session closes the open turn first, so its changes keep a row of their own. `SessionEnd`, turning the access off and the server stopping close open turns too. |
| The hook never blocks the agent | Nothing on stdout (a `UserPromptSubmit` hook's stdout is added to the prompt); a failure is a line on stderr and exit code 1, a non-blocking hook error; never exit code 2, which blocks the prompt. Timeouts: 30 s (`UserPromptSubmit`'s own limit), 60 s, and 30 s for `SessionEnd`, whose hooks otherwise share 1.5 s. |
| Which turns are taken | Only on a project open in a window that listens for external agents (409 otherwise), and none under the `none` Git strategy, as for the built-in agent. Agents other than Claude Code (`external_turns.AGENT_LABELS`) are refused. |
| An external turn while another agent works | Not prevented. The checkpoints are snapshots of the whole project, so a turn's diff (and its undo) also holds the built-in agent's or another session's concurrent changes; the guide says to let one agent work at a time. Refusing the prompt would block the agent, which a hook must not do. |
| Concurrent built-in and external control | Allowed for the safe window tools (each command is a short round trip). The window logs which party sent each command. |

## Phases

1. **Channel, discovery, token** (done): `opalatex/external_access.py`,
   `ide_control.WindowBus` / `use_command_channel`, `GET /api/ide/window/stream`,
   `GET|POST /api/settings/external-access`, the window's subscription
   (`gui_src/src/hooks/useWindowCommandChannel.js`).
2. **MCP server** (done): `agenticblocks/tools/mcp_server.py`
   (`MCPServerBridge`: callbacks or Blocks, stdio), `opalatex/external_mcp.py`
   (`opalatex mcp`), `opalatex/external_agent_tools.py` (catalog and call),
   `GET /api/external/windows`, `GET /api/external/tools`,
   `POST /api/external/call`, the settings section.
3. **Open in terminal and a live window state** (done):
   `opalatex/agent_clis.py`, `GET /api/external-agents/clis`,
   `POST /api/external-agents/launch`, `gui_src/src/utils/agentLauncher.js`,
   the bot button in `BottomPanel`, `tools.get_window_state`.
4. **Approval and a larger catalog** (in part): the approval of external
   calls (`external_agent_tools.call`, `request_approval` window command,
   `gui_src/src/utils/externalApprovals.js`) and `compile_latex` (done).
   Checkpoints of Claude Code's turns through its hooks (done:
   `opalatex/external_turns.py`, `opalatex/agent_hook.py`,
   `POST /api/external/turn`, `agent_clis.claude_hook_settings`).
   Not built: more tools that need approval (chats, checkpoint review),
   more safe ones (SyncTeX inverse navigation, panels), and checkpoints of
   Antigravity CLI's turns.

## Verified facts this design rests on

- `claude --mcp-config <configs...>` loads MCP servers "from JSON files or
  strings" for that session; `--strict-mcp-config` ignores every other MCP
  configuration (Claude Code's `--help`, 2026-11-24).
- `agy` 1.5.16 has no per-session MCP flag; `agy mcp add` writes
  `~/.gemini/config/mcp_config.json` (`{"mcpServers": {name: {...}}}`),
  verified with an isolated `HOME`; a stdio entry is `{"command", "args",
  "disabled": false}`, and `agy mcp add` replaces an entry of the same name.
  `agy --settings '{"mcpServers": ...}'` fails with `unknown setting
  "mcpServers"`.
- Claude Code's hooks (https://code.claude.com/docs/en/hooks, read
  2026-11-25): `UserPromptSubmit`, `Stop` and `SessionEnd` hooks are
  `{"hooks": {event: [{"hooks": [{"type": "command", "command", "timeout"}]}]}}`;
  `UserPromptSubmit` and `Stop` take no matcher; the input JSON has
  `session_id` and `cwd`; `Stop` does not run when the user interrupts the
  response; exit code 2 blocks a `UserPromptSubmit` prompt, other non-zero
  codes are non-blocking errors; hook entries merge across settings sources;
  `CLAUDE_PROJECT_DIR` is exported to the command; hooks of a settings file
  run only once the folder is trusted. Whether hooks in a `--settings` file
  load is not stated on the page: to verify by hand.
- Closing a terminal tab's session (`TerminalSession.close`) also ends a
  foreground program started in it (verified with `sleep`).

## Open items

- **Snap**: `confinement: strict` with the `home` plug does not reach hidden
  directories (`~/.local/bin`, `~/.claude`, `~/.gemini`), where both CLIs
  install themselves; the user confirmed that external agents fail there.
  **Decision (2026-11-25): the snap stays strict.** External agents are not
  supported in the snap: Settings shows a warning while the access is on
  inside the snap (`external_access.running_in_snap`, the `snap` field of
  `/api/settings/external-access`), the agent button's question to turn the
  access on starts with the same warning, and the guide (`tutorial.*.md`,
  *external-agents* and *installation*) recommends the `.deb` package or
  `install.sh`.
- **Windows**: the discovery file relies on the per-user profile directory's
  ACLs (`chmod` is a no-op there).
- **`agy` as a client**: registration verified with the real `agy` (isolated
  `HOME`), but no `agy` session has driven the window yet.
- **The approval dialog in the window**: covered by tests of each side and
  end to end with a simulated window, not yet answered in the desktop app.
- **Windows frozen build**: the release is a windowed (GUI-subsystem)
  executable. `opalatex mcp` reopens a standard stream Python left at None
  from the process's standard handle (`opalatex/protocol_stdio.py`), which a
  GUI process also receives from its parent's STARTUPINFO, and stops with a
  diagnostic when stdin or stdout has none, instead of the `os.devnull` that
  `main.py` gives the window. Covered by tests on Linux (the reopening with a
  stand-in handle; the diagnostic end to end); not yet run on Windows with a
  real client.
- **Antigravity CLI's turns**: the `agy` binary carries hook event names
  (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`) and
  `agy --settings` takes per-session settings, but whether it accepts hooks
  there, in which shape, and which event ends a response is unverified; its
  turns are not checkpointed.
- **Claude Code's hooks from the button's `--settings`**: covered by tests up
  to the command Claude Code would run; not yet seen running in a real
  Claude Code session.
- The tool descriptions are the built-in agent's and name some of its other
  tools (`read_file`, `get_project_overview`); an external agent uses its own
  equivalents.
