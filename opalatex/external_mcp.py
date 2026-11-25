"""`opalatex mcp`: the MCP server an agent outside OpalaTex starts over stdio.

docs/specs/external_agents.md, phase 2. A coding agent in a terminal (Claude
Code, Antigravity CLI, any MCP client) runs this command as its MCP server. It
holds no tools of its own: it finds the running OpalaTex whose window has the
agent's project open (the discovery files of `external_access`), and forwards
the catalog request and every tool call to that instance over loopback HTTP,
with the instance's token.

The agent's configuration therefore never changes: no port, no token, only
``opalatex mcp``. The project is the working directory the agent started in,
or ``--project``.

stdout carries the protocol. Every diagnostic goes to stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

#: Seconds for a catalog or window request, and for a tool call. A call may
#: wait for the user's approval in the window
#: (external_agent_tools.APPROVAL_TIMEOUT, 5 min) and then compile, which a
#: first run that fetches the TeX bundle makes long.
REQUEST_TIMEOUT = 10.0
CALL_TIMEOUT = 1800.0


class InstanceError(RuntimeError):
    """No usable OpalaTex instance; the message says what to do."""


class Unreachable(InstanceError):
    """The instance did not answer at all (closed, restarted on another port)."""


def _request(instance: dict, method: str, path: str, body: dict | None = None, *, timeout: float = REQUEST_TIMEOUT):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        instance["url"] + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {instance['token']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            reason = json.loads(error.read().decode("utf-8")).get("error") or ""
        except (ValueError, AttributeError):
            reason = ""
        raise InstanceError(f"OpalaTex at {instance['url']} answered HTTP {error.code}: {reason or error.reason}") from None
    except (urllib.error.URLError, OSError) as error:
        raise Unreachable(f"OpalaTex at {instance['url']} did not answer: {error}") from None


def _key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _contains(project: str, path: str) -> bool:
    try:
        return os.path.commonpath([_key(project), _key(path)]) == _key(project)
    except ValueError:  # different drives on Windows
        return False


def choose_project(path: str, open_projects: list[tuple[dict, str]]) -> tuple[dict, str] | None:
    """The (instance, project) whose project contains *path*: the innermost one,
    and among equals the first listed (instances come newest first)."""
    best = None
    for instance, project in open_projects:
        if _contains(project, path) and (best is None or len(_key(project)) > len(_key(best[1]))):
            best = (instance, project)
    return best


def resolve(path: str) -> tuple[dict, str]:
    """Find the running instance whose window has a project containing *path*."""
    from .external_access import list_instances

    instances = list_instances()
    if not instances:
        raise InstanceError(
            "OpalaTex is not running with external agent access turned on. Open OpalaTex, turn on "
            "Settings > External agents, then start this MCP server again."
        )
    open_projects: list[tuple[dict, str]] = []
    unreachable: list[str] = []
    for instance in instances:
        try:
            windows = _request(instance, "GET", "/api/external/windows").get("windows") or []
        except Unreachable as error:
            unreachable.append(str(error))
            continue
        open_projects += [(instance, w["project_path"]) for w in windows if w.get("project_path")]
    chosen = choose_project(path, open_projects)
    if chosen is not None:
        return chosen
    if open_projects:
        listed = ", ".join(sorted({project for _, project in open_projects}))
        raise InstanceError(
            f"No OpalaTex window has a project containing {path} open. Open projects: {listed}. "
            "Open the project in OpalaTex, or pass --project."
        )
    if unreachable:
        raise InstanceError("; ".join(unreachable))
    raise InstanceError(
        "OpalaTex is running but no window has a project open. Open the project in OpalaTex, then "
        "start this MCP server again."
    )


class Forwarder:
    """Forwards the MCP catalog and calls to the instance that has the project open."""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.instance, self.project = resolve(self.path)

    async def _send(self, method: str, path: str, body: dict | None = None, *, timeout: float = REQUEST_TIMEOUT):
        try:
            return await asyncio.to_thread(_request, self.instance, method, path, body, timeout=timeout)
        except Unreachable:
            # The instance went away (closed, or restarted on another port and
            # token): look for the project again, once, and repeat the request
            # there. The request is the same; only where it goes changes.
            self.instance, self.project = await asyncio.to_thread(resolve, self.path)
            return await asyncio.to_thread(_request, self.instance, method, path, body, timeout=timeout)

    async def catalog(self) -> dict:
        return await self._send("GET", "/api/external/tools")

    async def list_tools(self):
        from agenticblocks.tools.mcp_client import MCPToolSpec

        data = await self.catalog()
        return [MCPToolSpec.from_dict(spec) for spec in data.get("tools") or []]

    async def call_tool(self, name: str, arguments: dict):
        from agenticblocks.tools.mcp_client import MCPToolResult

        try:
            data = await self._send("POST", "/api/external/call", {
                "tool": name, "arguments": arguments, "project_path": self.project,
            }, timeout=CALL_TIMEOUT)
        except InstanceError as error:
            return MCPToolResult(content=[str(error)], is_error=True)
        return MCPToolResult(content=[str(c) for c in data.get("content") or []], is_error=bool(data.get("is_error")))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opalatex mcp",
        description=(
            "MCP server (stdio) that lets a coding agent such as Claude Code or Antigravity CLI drive "
            "the OpalaTex window that has its project open. Requires a running OpalaTex with "
            "Settings > External agents turned on."
        ),
    )
    parser.add_argument(
        "--project", default="",
        help="Project directory (default: the current working directory, or any directory inside the project).",
    )
    return parser


def main(argv: list[str]) -> int:
    from .protocol_stdio import require_protocol_stdio

    require_protocol_stdio("opalatex mcp")
    args = build_parser().parse_args(argv)
    path = os.path.abspath(args.project or os.getcwd())
    try:
        forwarder = Forwarder(path)
        instructions = (asyncio.run(forwarder.catalog()) or {}).get("instructions")
    except InstanceError as error:
        print(f"opalatex mcp: {error}", file=sys.stderr)
        return 1

    from agenticblocks.tools.mcp_server import MCPServerBridge

    from . import __version__

    print(f"opalatex mcp: serving project {forwarder.project} of OpalaTex at {forwarder.instance['url']}", file=sys.stderr)
    bridge = MCPServerBridge(
        "opalatex",
        version=__version__,
        instructions=instructions,
        list_tools=forwarder.list_tools,
        call_tool=forwarder.call_tool,
    )
    asyncio.run(bridge.run_stdio())
    return 0
