"""Commands the agent sends to the desktop IDE, and the IDE's answers.

The agent's file and compile tools act on the disk; these act on the *window*:
which tabs are open and which one is focused. The window is the only party that
knows its own state, so a command is a round trip rather than a fire-and-forget
event: `send_ide_command` publishes an `ide_command` event on the turn's stream,
the desktop app carries it out with the same handlers a click uses
(`gui_src/src/utils/ideCommands.js`) and posts the outcome, together with the
resulting tab state, to `/api/opalatex/ide_command_result`, which resolves the
pending future here.

This is not the `input_request` channel (`agent_stdin.request_user_input`):
that one waits for a *person* and may wait a day; this one waits for the
application, which answers in milliseconds or not at all. An unanswered command
therefore fails after a short timeout with a diagnostic -- the window may be
closed or disconnected -- instead of pretending the command took effect.

Only the desktop app answers these commands, so the tools that send them are
withheld from the command-line interface (`prompt_surface.GUI_ONLY_TOOLS`).

**Two channels carry a command to the window.** The built-in agent's turn
stream is the default and the one its tools always use. An agent outside
OpalaTex (docs/specs/external_agents.md) calls when no turn is running, so its
commands go through the *window channel* instead: a stream the window keeps
open while external access is on (`WindowBus`, `GET /api/ide/window/stream`).
The caller picks the channel explicitly with `use_command_channel`; a command
never moves from one channel to the other. Both are answered through the same
endpoint and resolve the same pending futures.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import os
import sys
import time
import uuid

#: Seconds the window gets to carry out a command. Opening a file reads it over
#: the local API, which is milliseconds; anything near this means no window is
#: listening.
IDE_COMMAND_TIMEOUT = 15.0

_pending: dict[str, asyncio.Future] = {}


class IdeCommandError(ValueError):
    """The IDE did not carry out a command; the message says why."""


class TurnStreamChannel:
    """The built-in agent's channel: an `ide_command` event on the turn's stream."""

    def deliver(self, command_id: str, payload: dict) -> None:
        from opalatex.agent_stdin import print_event

        print_event("ide_command", payload)

    def publish(self, event: str, data: dict) -> None:
        from opalatex.agent_stdin import print_event

        print_event(event, data)

    def release(self, command_id: str) -> None:
        pass

    def timeout_message(self, action: str, timeout: float) -> str:
        return (
            f"The IDE window did not answer the '{action}' command within {timeout:.0f} s: "
            "it may be closed or disconnected from this turn (for example after the computer "
            "slept). Do not retry it; tell the user what you meant to show them instead."
        )


TURN_STREAM = TurnStreamChannel()

_command_channel: contextvars.ContextVar = contextvars.ContextVar("ide_command_channel", default=None)


@contextlib.contextmanager
def use_command_channel(channel):
    """Send the commands issued inside this block through *channel*."""
    token = _command_channel.set(channel)
    try:
        yield channel
    finally:
        _command_channel.reset(token)


def _project_key(path: str) -> str:
    key = os.path.normcase(os.path.abspath(str(path or "")))
    if sys.platform == "win32":
        key = key.lower()
    return key.rstrip("\\/") or key


class WindowConnection:
    """One window's open command stream (`GET /api/ide/window/stream`)."""

    def __init__(self, window_id: str, project_path: str):
        self.window_id = window_id
        self.project_path = project_path
        self.project_key = _project_key(project_path) if project_path else ""
        self.connected_at = time.monotonic()
        # The server's loop, which owns the queue: a tool running in a worker
        # thread (compile_latex) publishes through it.
        self.loop = asyncio.get_running_loop()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.pending: set[str] = set()
        self.closed = False

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.queue.put_nowait(None)


class WindowBus:
    """The windows listening for commands outside any agent turn.

    Lives on the server's event loop: the stream endpoint connects and
    disconnects windows there, and `send_ide_command` delivers there.
    """

    def __init__(self):
        self._windows: dict[str, WindowConnection] = {}

    def connect(self, window_id: str, project_path: str) -> WindowConnection:
        """Register a window's stream, replacing an older stream of the same window."""
        previous = self._windows.get(window_id)
        connection = WindowConnection(window_id, project_path)
        self._windows[window_id] = connection
        if previous is not None:
            self._fail_pending(previous, "the window reopened its command stream")
            previous.close()
        return connection

    def disconnect(self, connection: WindowConnection) -> None:
        if self._windows.get(connection.window_id) is connection:
            del self._windows[connection.window_id]
        self._fail_pending(connection, "the window disconnected before answering")
        connection.close()

    def close_all(self) -> None:
        for connection in list(self._windows.values()):
            self.disconnect(connection)

    def windows(self) -> list[WindowConnection]:
        return sorted(self._windows.values(), key=lambda c: c.connected_at, reverse=True)

    def find(self, project_path: str) -> WindowConnection | None:
        """The most recently connected window that has *project_path* open."""
        key = _project_key(project_path)
        for connection in self.windows():
            if connection.project_key == key:
                return connection
        return None

    @staticmethod
    def _fail_pending(connection: WindowConnection, reason: str) -> None:
        for command_id in list(connection.pending):
            resolve_ide_command(command_id, {"ok": False, "error": f"The IDE window did not carry out the command: {reason}."})
        connection.pending.clear()


WINDOW_BUS = WindowBus()


class WindowChannel:
    """Commands of an agent outside OpalaTex: delivered on a window's own stream."""

    def __init__(self, bus: WindowBus | None = None):
        self.bus = bus or WINDOW_BUS
        self._connections: dict[str, WindowConnection] = {}

    def deliver(self, command_id: str, payload: dict) -> None:
        project_path = payload.get("project_path") or ""
        connection = self.bus.find(project_path)
        if connection is None:
            raise IdeCommandError(
                f"No OpalaTex window has the project {project_path} open with external agent "
                "access turned on. Open the project in OpalaTex, or check that external agent "
                "access is on in Settings."
            )
        connection.pending.add(command_id)
        self._connections[command_id] = connection
        connection.queue.put_nowait({"event": "ide_command", **payload})

    def release(self, command_id: str) -> None:
        connection = self._connections.pop(command_id, None)
        if connection is not None:
            connection.pending.discard(command_id)

    def publish(self, event: str, data: dict) -> None:
        """An event the window shows and does not answer (e.g. `latex_compiled`),
        to the window of its project. From any thread; dropped when that window
        is gone, as a turn's event is when its stream is."""
        connection = self.bus.find(data.get("project_path") or "")
        if connection is None or connection.closed:
            return
        payload = {"event": event, **data}
        try:
            on_loop = asyncio.get_running_loop() is connection.loop
        except RuntimeError:
            on_loop = False
        if on_loop:
            connection.queue.put_nowait(payload)
        elif not connection.loop.is_closed():
            connection.loop.call_soon_threadsafe(connection.queue.put_nowait, payload)

    def timeout_message(self, action: str, timeout: float) -> str:
        return (
            f"The OpalaTex window did not answer the '{action}' command within {timeout:.0f} s. "
            "It may be busy or hung; do not retry the command in a loop."
        )


def publish_ide_event(event: str, data: dict) -> None:
    """Show the window an event through the channel of the current call."""
    (_command_channel.get() or TURN_STREAM).publish(event, data)


async def send_ide_command(
    action: str,
    args: dict,
    *,
    project_path: str,
    timeout: float = IDE_COMMAND_TIMEOUT,
) -> dict:
    """Ask the desktop window to perform *action* and return its answer.

    The answer is the dict the window posted, always with ``ok`` true; a refusal
    (``ok`` false) or no answer raises :class:`IdeCommandError` carrying the
    window's own reason, so the caller reports it rather than guessing.

    The command goes through the channel `use_command_channel` set, and through
    the turn's stream when none is set.
    """
    channel = _command_channel.get() or TURN_STREAM
    loop = asyncio.get_running_loop()
    command_id = str(uuid.uuid4())
    future = loop.create_future()
    _pending[command_id] = future
    try:
        channel.deliver(command_id, {
            "id": command_id,
            "action": action,
            "args": dict(args),
            "project_path": project_path,
        })
        try:
            result = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except asyncio.TimeoutError:
            raise IdeCommandError(channel.timeout_message(action, timeout)) from None
    finally:
        channel.release(command_id)
        _pending.pop(command_id, None)
        if not future.done():
            future.cancel()

    if not isinstance(result, dict):
        raise IdeCommandError(f"The IDE window sent a malformed answer to '{action}'.")
    if not result.get("ok"):
        reason = str(result.get("error") or "").strip()
        raise IdeCommandError(reason or f"The IDE window refused '{action}' without giving a reason.")
    return result


def resolve_ide_command(command_id: str, result: dict) -> bool:
    """Deliver the window's answer to a pending command.

    Returns False when no command with that id is waiting (it timed out, or the
    id is unknown). Safe to call from any thread.
    """
    future = _pending.get(command_id)
    if future is None or future.done():
        return False

    def _deliver() -> None:
        if not future.done():
            future.set_result(result)

    future.get_loop().call_soon_threadsafe(_deliver)
    return True
