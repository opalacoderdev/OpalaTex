"""Checkpoints of an external agent's turns (docs/specs/external_agents.md).

An agent outside OpalaTex edits files with its own tools, outside any OpalaTex
turn, so nothing of it reached Review. When the agent can run commands at the
start and end of its turns (Claude Code's hooks), those commands --
``opalatex agent-hook``, forwarded here -- open and close the same shadow-Git
checkpoints the built-in agent's turns use (`vcs.AsyncAgentTurnCheckpoint`),
labelled with the agent's name. Review then shows each of the agent's turns as
one row, with its diff and its undo.

A turn is keyed by project and agent session. The start of a turn closes a turn
of the same session that is still open: an interrupted response does not run
the agent's end-of-turn hook, and its changes stay in a turn of their own.
Turns are taken only on a project open in a window that listens for external
agents, and not at all under the "none" Git strategy, as for the built-in agent.

The checkpoints are snapshots of the whole project: while the built-in agent
or another session works on the same project at the same time, a turn's diff
also holds their changes, and so does its undo.
"""

from __future__ import annotations

import asyncio

#: The agents whose turns can be checkpointed, by id: the name Review shows.
AGENT_LABELS = {"claude": "Claude Code"}

#: The longest session id accepted (Claude Code's are UUIDs).
SESSION_MAX_CHARS = 200

EVENTS = ("turn-start", "turn-end", "session-end")


class ExternalTurns:
    """The external agents' turns that are open, per (project, session)."""

    def __init__(self, bus=None):
        from .ide_control import WINDOW_BUS

        self.bus = bus or WINDOW_BUS
        self._open: dict[tuple[str, str], object] = {}
        self._lock: asyncio.Lock | None = None

    def _guard(self) -> asyncio.Lock:
        # Created on first use, on the loop that serves the requests.
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    @staticmethod
    def _key(project_path: str, session: str) -> tuple[str, str]:
        from .ide_control import _project_key

        return (_project_key(project_path), session)

    def open_turns(self) -> list[tuple[str, str]]:
        return list(self._open)

    async def handle(self, event: str, agent: str, session: str, project_path: str) -> tuple[int, dict]:
        """Apply one hook event. Returns (HTTP status, JSON body)."""
        if event not in EVENTS:
            return 400, {"error": f"Unknown event '{event}'. Events: {', '.join(EVENTS)}."}
        label = AGENT_LABELS.get(agent)
        if label is None:
            return 400, {"error": f"Unknown agent '{agent}'. Agents: {', '.join(AGENT_LABELS)}."}
        if not session or len(session) > SESSION_MAX_CHARS:
            return 400, {"error": f"The session id must have 1 to {SESSION_MAX_CHARS} characters."}
        if not project_path or self.bus.find(project_path) is None:
            return 409, {"error": (
                f"No OpalaTex window has the project {project_path} open with external agent access "
                "turned on, so this turn is not checkpointed."
            )}
        from .config import get_git_strategy

        if get_git_strategy().lower() == "none":
            return 200, {"ok": True, "checkpoint": None, "reason": "The Git strategy is 'none': no checkpoints."}

        key = self._key(project_path, session)
        async with self._guard():
            closed = await self._close(key)
            if event != "turn-start":
                return 200, {"ok": True, "closed": closed}
            from .vcs import AsyncAgentTurnCheckpoint

            turn = AsyncAgentTurnCheckpoint(project_path, label)
            start = await turn.begin()
            if not start:
                return 500, {"error": "The start checkpoint could not be taken.", "closed": closed}
            self._open[key] = turn
            return 200, {"ok": True, "checkpoint": start, "closed": closed}

    async def _close(self, key) -> dict | None:
        turn = self._open.pop(key, None)
        if turn is None:
            return None
        saved = await turn.finalize()
        self._publish(turn, saved)
        return {"saved": saved, "changed_files": list(turn.changed_files)}

    async def close_all(self) -> None:
        """Close every open turn (external access turned off)."""
        async with self._guard():
            for key in list(self._open):
                await self._close(key)

    def close_all_now(self) -> None:
        """Close every open turn from synchronous code (the server stopping)."""
        from .vcs import finalize_agent_turn_checkpoint

        for key in list(self._open):
            turn = self._open.pop(key)
            finalize_agent_turn_checkpoint(turn.project_path, turn.start_checkpoint, turn.agent_label)

    def _publish(self, turn, saved: bool) -> None:
        """What the built-in agent's turn reports when it ends, to the window:
        Review refreshes, and open tabs of the changed files reload."""
        from .ide_control import WindowChannel

        WindowChannel(self.bus).publish("checkpoint_finalized", {
            "agent": turn.agent_label,
            "external": True,
            "success": bool(saved),
            "changed_files": list(turn.changed_files),
            "project_path": turn.project_path,
        })


EXTERNAL_TURNS = ExternalTurns()
