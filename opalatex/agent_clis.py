"""Coding agents OpalaTex opens in its terminal, connected to `opalatex mcp`.

docs/specs/external_agents.md, phase 3. The "open in terminal" button starts a
coding agent's own CLI in a terminal tab of the project, already configured
with OpalaTex's MCP server. Each agent takes that configuration differently:

* **Claude Code** (`claude`) loads MCP servers for one session from a file,
  ``--mcp-config <file>``. OpalaTex writes that file in its own data folder;
  nothing is written into Claude Code's configuration.
* **Antigravity CLI** (`agy`) has no per-session MCP option (``--settings``
  rejects ``mcpServers``, verified with agy 1.5.16), only its user-level
  ``~/.gemini/config/mcp_config.json``. OpalaTex registers the server there
  through ``agy mcp add`` -- the CLI's own command, never by editing the file
  -- and only after the user agreed to it.

The CLI is looked up on the ``PATH`` of the shell the terminal tab runs, which
is not the ``PATH`` of the window's process: a desktop launch usually lacks
what the user's shell startup files add (``~/.local/bin``, an npm prefix).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .atomic_file import write_text_atomic
from .config import get_opalatex_home

#: The name the server has in an agent's configuration.
SERVER_NAME = "opalatex"

_PATH_MARKER = "__OPALATEX_TERMINAL_PATH__="


@dataclass(frozen=True)
class AgentCli:
    id: str
    label: str
    executable: str


AGENT_CLIS = {
    "claude": AgentCli("claude", "Claude Code", "claude"),
    "antigravity": AgentCli("antigravity", "Antigravity CLI", "agy"),
}


class AgentCliError(ValueError):
    """The agent cannot be started; ``code`` says why, the message what to do."""

    def __init__(self, code: str, message: str, **details):
        super().__init__(message)
        self.code = code
        self.details = details


# ─── Finding the executable ──────────────────────────────────────────────────

def terminal_search_path() -> str:
    """The ``PATH`` of a shell started by the integrated terminal.

    On Unix the terminal runs an interactive ``/bin/bash`` (terminal_manager),
    which reads ``~/.bashrc``; the same shell is asked for its ``PATH``. If it
    cannot answer, the process's own ``PATH`` is searched, which finds less but
    never something the terminal would not run.
    """
    from .external_tools import environment_with_managed_tools

    env = environment_with_managed_tools()
    if sys.platform == "win32" or not os.path.exists("/bin/bash"):
        return env.get("PATH", "")
    try:
        completed = subprocess.run(
            ["/bin/bash", "-ic", f'printf "\\n{_PATH_MARKER}%s\\n" "$PATH"'],
            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return env.get("PATH", "")
    for line in completed.stdout.splitlines():
        if line.startswith(_PATH_MARKER):
            return line[len(_PATH_MARKER):]
    return env.get("PATH", "")


def find_cli(agent: AgentCli, search_path: str | None = None) -> str | None:
    path = terminal_search_path() if search_path is None else search_path
    return shutil.which(agent.executable, path=path)


def not_found_message(agent: AgentCli) -> str:
    message = (
        f"{agent.label} was not found: no `{agent.executable}` command on the PATH of the "
        f"integrated terminal. Install {agent.label}, make sure `{agent.executable}` runs in a new "
        "terminal, and try again."
    )
    if os.environ.get("SNAP"):
        message += (
            " OpalaTex runs as a snap here, and the snap's confinement may hide programs installed "
            "in hidden folders of your home (such as ~/.local/bin). If it is installed, start it "
            "from a terminal outside OpalaTex instead."
        )
    return message


# ─── Configuration ───────────────────────────────────────────────────────────

def claude_mcp_config_path() -> Path:
    return Path(get_opalatex_home()) / "external_access" / "claude-mcp.json"


def write_claude_mcp_config(mcp_command: list[str]) -> Path:
    """The ``--mcp-config`` file of a Claude Code session. Holds no secret: the
    server finds the instance and its token by itself."""
    path = claude_mcp_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"mcpServers": {SERVER_NAME: {
        "type": "stdio", "command": mcp_command[0], "args": list(mcp_command[1:]),
    }}}
    write_text_atomic(str(path), json.dumps(document, indent=2) + "\n")
    return path


def claude_settings_path() -> Path:
    return Path(get_opalatex_home()) / "external_access" / "claude-settings.json"


#: Claude Code's hook events, and the `opalatex agent-hook` event each runs.
#: ``Stop`` does not run when the user interrupts the response; the next
#: prompt's ``turn-start`` closes that turn, or ``SessionEnd`` does.
CLAUDE_HOOK_EVENTS = {
    "UserPromptSubmit": "turn-start",
    "Stop": "turn-end",
    "SessionEnd": "session-end",
}
#: Seconds per hook. ``SessionEnd`` hooks otherwise share a 1.5 s budget, too
#: short for a checkpoint; ``UserPromptSubmit``'s own limit is 30 s.
CLAUDE_HOOK_TIMEOUTS = {"UserPromptSubmit": 30, "Stop": 60, "SessionEnd": 30}


def claude_hook_command_line(argv: list[str], *, windows: bool | None = None) -> str:
    """*argv* as the ``command`` string of a Claude Code hook (a shell line)."""
    windows = sys.platform == "win32" if windows is None else windows
    if windows:
        return subprocess.list2cmdline([str(arg) for arg in argv])
    import shlex

    return shlex.join(str(arg) for arg in argv)


def claude_hook_settings(hook_command) -> dict:
    """The ``--settings`` document of a Claude Code session: hooks that open and
    close OpalaTex checkpoints of its turns. *hook_command(event)* is the argv
    of ``opalatex agent-hook <event> --agent claude``. Claude Code merges these
    hooks with the user's own; nothing of the user's configuration changes."""
    return {"hooks": {
        claude_event: [{"hooks": [{
            "type": "command",
            "command": claude_hook_command_line(hook_command(event)),
            "timeout": CLAUDE_HOOK_TIMEOUTS[claude_event],
        }]}]
        for claude_event, event in CLAUDE_HOOK_EVENTS.items()
    }}


def write_claude_settings(hook_command) -> Path:
    """The ``--settings`` file of a Claude Code session (no secret in it)."""
    path = claude_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text_atomic(str(path), json.dumps(claude_hook_settings(hook_command), indent=2) + "\n")
    return path


def antigravity_config_path() -> Path:
    return Path.home() / ".gemini" / "config" / "mcp_config.json"


def antigravity_registration(mcp_command: list[str]) -> dict:
    """Whether ``agy`` already starts this installation's ``opalatex mcp``.

    ``state`` is ``registered``, ``missing`` or ``different`` (another command,
    or disabled); ``current`` is the entry found, for the user to see.
    """
    try:
        text = antigravity_config_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"state": "missing", "current": None}
    except OSError:
        return {"state": "different", "current": None}
    if not text.strip():  # agy leaves an empty file behind when no server is configured
        return {"state": "missing", "current": None}
    try:
        document = json.loads(text)
    except ValueError:
        return {"state": "different", "current": None}
    servers = document.get("mcpServers") if isinstance(document, dict) else None
    entry = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
    if not isinstance(entry, dict):
        return {"state": "missing", "current": None}
    matches = (
        entry.get("command") == mcp_command[0]
        and list(entry.get("args") or []) == list(mcp_command[1:])
        and entry.get("disabled") is not True
    )
    return {"state": "registered" if matches else "different", "current": entry}


def register_antigravity(agy: str, mcp_command: list[str]) -> None:
    """Add or update the server in agy's configuration, with agy's own command."""
    try:
        completed = subprocess.run(
            [agy, "mcp", "add", SERVER_NAME, "--", *mcp_command],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AgentCliError("registration_failed", f"`agy mcp add` could not run: {error}") from None
    if completed.returncode != 0:
        output = (completed.stderr or completed.stdout or "").strip()
        raise AgentCliError("registration_failed", f"`agy mcp add` failed: {output or f'exit code {completed.returncode}'}")
    if antigravity_registration(mcp_command)["state"] != "registered":
        raise AgentCliError(
            "registration_failed",
            f"`agy mcp add` reported success, but {antigravity_config_path()} does not start "
            "OpalaTex's server. Register it by hand with the command shown in Settings.",
        )


# ─── The command typed into the terminal ─────────────────────────────────────

def launch_argv(agent: AgentCli, executable: str, mcp_command: list[str], hook_command=None) -> list[str]:
    """The command line that starts *agent* connected to OpalaTex.

    Claude Code gets its MCP server and, given *hook_command* (see
    `claude_hook_settings`), the hooks that checkpoint its turns, both for this
    session only. Antigravity CLI reads its registration (`register_antigravity`).
    """
    if agent.id == "claude":
        argv = [executable, "--mcp-config", str(write_claude_mcp_config(mcp_command))]
        if hook_command is not None:
            argv += ["--settings", str(write_claude_settings(hook_command))]
        return argv
    return [executable]


def _powershell_quote(arg: str) -> str:
    return "'" + arg.replace("'", "''") + "'"


def shell_line(argv: list[str], *, windows: bool | None = None) -> str:
    """*argv* as a line for the terminal's shell: bash, or PowerShell on Windows."""
    windows = sys.platform == "win32" if windows is None else windows
    if windows:
        return "& " + " ".join(_powershell_quote(str(arg)) for arg in argv)
    import shlex

    return shlex.join(str(arg) for arg in argv)


def describe(search_path: str | None = None) -> list[dict]:
    """Each agent with whether it was found, for the window's menu."""
    from .external_access import mcp_command

    path = terminal_search_path() if search_path is None else search_path
    command = mcp_command()
    found = []
    for agent in AGENT_CLIS.values():
        executable = find_cli(agent, path)
        item = {"id": agent.id, "label": agent.label, "executable": agent.executable, "path": executable or ""}
        if agent.id == "antigravity":
            item["registration"] = antigravity_registration(command)["state"]
        found.append(item)
    return found
