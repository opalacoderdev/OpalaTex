"""`opalatex agent-hook`: an external agent's turn starts or ends.

docs/specs/external_agents.md. An agent's own hooks run this command (Claude
Code: ``UserPromptSubmit`` → ``turn-start``, ``Stop`` → ``turn-end``,
``SessionEnd`` → ``session-end``; see `agent_clis.claude_hook_settings`). It
reads the hook's JSON from stdin (``session_id``, ``cwd``), finds the running
OpalaTex whose window has the project open, as `opalatex mcp` does, and asks it
to open or close the checkpoints of that turn (`opalatex.external_turns`).

It never blocks the agent and never speaks to it: nothing is written to stdout
(a ``UserPromptSubmit`` hook's stdout would be added to the prompt), and a
failure is a line on stderr with exit code 1, which Claude Code reports as a
non-blocking hook error. Exit code 2, which would block the prompt, is never
used.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

#: Seconds to wait for OpalaTex; under Claude Code's 30 s budget for a
#: ``UserPromptSubmit`` hook. Taking a checkpoint of a large project takes a while.
REQUEST_TIMEOUT = 25.0


def build_parser() -> argparse.ArgumentParser:
    from .external_turns import AGENT_LABELS, EVENTS

    parser = argparse.ArgumentParser(
        prog="opalatex agent-hook",
        description=(
            "Run by a coding agent's hooks: opens or closes the OpalaTex checkpoints of the agent's "
            "turn, so Review shows it and can undo it. Reads the hook's JSON from stdin."
        ),
    )
    parser.add_argument("event", choices=EVENTS)
    parser.add_argument("--agent", required=True, choices=sorted(AGENT_LABELS))
    return parser


def _hook_input(stream) -> dict:
    try:
        text = stream.read() if stream is not None else ""
    except (OSError, ValueError):
        return {}
    try:
        data = json.loads(text) if text.strip() else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def project_dir(hook: dict, environ=os.environ) -> str:
    """Where the agent works: Claude Code's project root (``CLAUDE_PROJECT_DIR``,
    where the session started), else the hook's ``cwd``, else this process's."""
    return os.path.abspath(environ.get("CLAUDE_PROJECT_DIR") or hook.get("cwd") or os.getcwd())


def main(argv: list[str], *, stdin=None) -> int:
    args = build_parser().parse_args(argv)
    hook = _hook_input(sys.stdin if stdin is None else stdin)
    session = str(hook.get("session_id") or "").strip()
    if not session:
        print("opalatex agent-hook: the hook input has no session_id; this turn is not checkpointed.", file=sys.stderr)
        return 1

    from .external_mcp import InstanceError, _request, resolve

    try:
        instance, project = resolve(project_dir(hook))
        _request(instance, "POST", "/api/external/turn", {
            "event": args.event, "agent": args.agent, "session": session, "project_path": project,
        }, timeout=REQUEST_TIMEOUT)
    except InstanceError as error:
        print(f"opalatex agent-hook: {error}", file=sys.stderr)
        return 1
    return 0
