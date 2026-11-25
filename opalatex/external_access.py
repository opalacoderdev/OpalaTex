"""Access to a running OpalaTex by agents outside it (docs/specs/external_agents.md).

Coding agents that run in a terminal -- Claude Code, Antigravity CLI, any MCP
client -- reach a running OpalaTex through `opalatex mcp`, a stdio MCP server
that forwards their calls to the instance over loopback HTTP. This module is the
instance's side of that arrangement:

* the **setting** that turns it on, ``<opalatex home>/external_access.json``,
  off by default. Off, nothing below exists outside the process;
* the **token** a forwarded call must carry, random per process and distinct
  from the window's session cookie (`local_auth.LocalSession`): the cookie
  means "the window" and is never written to disk;
* the **discovery file** a CLI reads to find the instance, one per running
  instance in ``<opalatex home>/external_access/instances/``, because the
  server's port changes between launches (`find_available_port`).
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from .atomic_file import write_text_atomic
from .config import get_opalatex_home

#: Format tag of a discovery file; a reader refuses any other.
INSTANCE_FORMAT = "opalatex-external-access/1"


# ─── The setting ──────────────────────────────────────────────────────────────

def config_path() -> Path:
    return Path(get_opalatex_home()) / "external_access.json"


def load_config() -> dict[str, Any]:
    """The stored setting, ``{"enabled": False}`` when absent or unreadable."""
    try:
        raw = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"enabled": False}
    if not isinstance(raw, dict):
        return {"enabled": False}
    return {"enabled": raw.get("enabled") is True}


def save_config(config: dict[str, Any]) -> dict[str, Any]:
    stored = {"enabled": config.get("enabled") is True}
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text_atomic(str(path), json.dumps(stored, indent=2) + "\n")
    return stored


def is_enabled() -> bool:
    return load_config()["enabled"]


# ─── Discovery files ──────────────────────────────────────────────────────────

def instances_dir() -> Path:
    return Path(get_opalatex_home()) / "external_access" / "instances"


def _instance_path(port: int) -> Path:
    return instances_dir() / f"{int(port)}.json"


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for directory in (path, path.parent):
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass  # Windows: the per-user profile's ACLs protect it.


def list_instances() -> list[dict[str, Any]]:
    """The running instances that accept external agents, newest first.

    A file whose process is gone (a crash, a restart that skipped the cleanup)
    is skipped, not deleted: another user's process could have reused the pid
    of a file we cannot vouch for, and the instance that owns the port rewrites
    it when it starts.
    """
    from .monitors.process import pid_alive

    found = []
    try:
        entries = sorted(instances_dir().glob("*.json"))
    except OSError:
        return []
    for entry in entries:
        try:
            record = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("format") != INSTANCE_FORMAT:
            continue
        pid = record.get("pid")
        if not isinstance(pid, int) or not pid_alive(pid):
            continue
        if not isinstance(record.get("url"), str) or not isinstance(record.get("token"), str):
            continue
        found.append(record)
    found.sort(key=lambda r: r.get("started_at") or 0, reverse=True)
    return found


class ExternalAccess:
    """One server's external-access state: its token and its discovery file."""

    def __init__(self, url: str, port: int):
        self.url = url
        self.port = int(port)
        self.token = secrets.token_urlsafe(32)
        self.started_at = time.time()
        self._published: Path | None = None
        self._lock = threading.Lock()

    @property
    def published(self) -> bool:
        return self._published is not None

    def publish(self) -> Path:
        """Write this instance's discovery file (owner-only), replacing a stale one."""
        with self._lock:
            path = _instance_path(self.port)
            _private_dir(path.parent)
            record = {
                "format": INSTANCE_FORMAT,
                "pid": os.getpid(),
                "url": self.url,
                "token": self.token,
                "started_at": self.started_at,
            }
            write_text_atomic(str(path), json.dumps(record, indent=2) + "\n", mode=0o600)
            self._published = path
            return path

    def withdraw(self) -> None:
        """Remove the discovery file this instance wrote, and only that one."""
        with self._lock:
            path, self._published = self._published, None
            if path is None:
                return
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return
            # A newer instance on the same port may have replaced it since.
            if isinstance(record, dict) and record.get("token") == self.token:
                try:
                    path.unlink()
                except OSError:
                    pass

    def apply(self, enabled: bool) -> None:
        """Make the discovery file match the setting."""
        if enabled:
            self.publish()
        else:
            self.withdraw()

    def authenticated(self, headers: dict) -> bool:
        """True when *headers* carry this instance's token as a bearer credential.

        Only for the external endpoints; the window's `/api/*` keeps requiring
        the session cookie. Refused while external access is off, so a token
        read before the user turned it off stops working at once.
        """
        if self._published is None:
            return False
        value = str(headers.get("authorization") or "")
        scheme, _, credential = value.partition(" ")
        if scheme.lower() != "bearer" or not credential:
            return False
        return secrets.compare_digest(credential.strip(), self.token)


#: The running server's state, so exit paths that bypass `AsyncHTTPServer.stop`
#: (the in-app restart's ``os._exit``) can still remove its discovery file.
_current: ExternalAccess | None = None


def register_current(access: ExternalAccess | None) -> None:
    global _current
    _current = access


def withdraw_current() -> None:
    access = _current
    if access is not None:
        access.withdraw()


# ─── The command an agent starts ──────────────────────────────────────────────

def running_in_snap() -> bool:
    """True inside the snap package.

    Its strict confinement hides the hidden folders of the home (``~/.local/bin``,
    ``~/.claude``, ``~/.gemini``) where Claude Code and Antigravity CLI install
    themselves, so external agents may not work there: Settings warns when the
    access is turned on, and the guide recommends the .deb or install.sh.
    """
    return bool(os.environ.get("SNAP") and (os.environ.get("SNAP_INSTANCE_NAME") or os.environ.get("SNAP_NAME")))


def opalatex_command() -> list[str]:
    """The argv that runs this installation's ``opalatex`` command, for a
    program outside OpalaTex (an agent) to start a subcommand of it.

    Unlike `monitors.process.opalatex_command`, never ``pythonw.exe``: the agent
    talks to ``opalatex mcp`` over its stdin/stdout, which a windowless
    interpreter may not have. Inside a snap the interpreter is not reachable
    from outside the confinement, so the snap's own command is given instead.
    """
    if running_in_snap():
        snap = os.environ.get("SNAP_INSTANCE_NAME") or os.environ.get("SNAP_NAME")
        return [f"/snap/bin/{snap}"]
    import sys

    if getattr(sys, "frozen", False):
        return [sys.executable]
    package_dir = os.path.dirname(os.path.abspath(__file__))
    main_py = os.path.join(os.path.dirname(package_dir), "main.py")
    if os.path.isfile(main_py):
        return [sys.executable, main_py]
    return [sys.executable, "-m", "opalatex.cli"]


def mcp_command() -> list[str]:
    """The argv of ``opalatex mcp`` for this installation, to register in an agent."""
    return [*opalatex_command(), "mcp"]


def agent_hook_command(event: str, agent_id: str) -> list[str]:
    """The argv of ``opalatex agent-hook <event> --agent <id>``, which an agent's
    own hooks run to open and close OpalaTex checkpoints of its turns
    (`opalatex.agent_hook`)."""
    return [*opalatex_command(), "agent-hook", event, "--agent", agent_id]
