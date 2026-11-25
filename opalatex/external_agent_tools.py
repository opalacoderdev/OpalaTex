"""The tools an agent outside OpalaTex may call, and how one of its calls runs.

docs/specs/external_agents.md. The tools are the built-in agent's own Blocks,
so their contract -- schema, validation, messages -- has one definition for
both. What differs is the context a call runs in:

* the **project** is the call's own (`tools.project_path_for_call`), never the
  module globals a running agent turn has bound;
* window commands and events go through the **window channel**
  (`ide_control.WindowChannel`), since no turn stream exists for an external call;
* the **permission** is this module's gate, not the chat's mode: a tool that is
  not safe (`tools.TOOL_SAFETY`) runs only after the user approved it in the
  window, every time, unless they answered "always" for that tool and project.
  The external agent's own permission prompts are not relied on: OpalaTex
  cannot see how that agent was configured.
"""

from __future__ import annotations

from agenticblocks.tools.mcp_client import MCPToolResult
from agenticblocks.tools.mcp_server import call_block, spec_from_block, validate_block_arguments

#: Shown to the client at initialization: what these tools are for.
SERVER_INSTRUCTIONS = (
    "These tools drive the OpalaTex desktop window the user has open on this project: open or "
    "close editor tabs, change the window layout, show where a LaTeX line lands in the compiled "
    "PDF, and read the window's open tabs, cursor and selection, Problems panel and main "
    "terminal. compile_latex compiles with OpalaTex's own Tectonic and shows the result in the "
    "window (PDF pane, Problems); the user approves it in the window, so a call may wait for "
    "them. Paths are relative to the project root."
)

#: Seconds the window's approval dialog waits for the user. An unanswered
#: request is not permission.
APPROVAL_TIMEOUT = 300.0
#: Extra seconds the backend waits past the dialog's own timeout, for the
#: window's "no" to arrive after it closes the dialog.
APPROVAL_MARGIN = 10.0

#: (project key, tool) pairs the user answered "always" for. Kept in memory
#: while external access stays on; forgotten when it is turned off or the
#: application restarts.
_ALWAYS_ALLOWED: set[tuple[str, str]] = set()


def forget_approvals() -> None:
    _ALWAYS_ALLOWED.clear()


def exposed_tools() -> list:
    """The built-in agent's IDE control tools, `get_window_state` and `compile_latex`.

    `get_window_state` reads the window live. The built-in agent has
    `get_editor_state` instead, which reads what its own turn staged; that is
    stale for a caller outside any turn, so it is not exposed here.
    """
    from .tools import compile_latex, get_ide_control_tools, get_window_state

    return [*get_ide_control_tools(), get_window_state, compile_latex]


def catalog() -> list[dict]:
    """The exposed tools as MCP tool specs (JSON)."""
    from .tools import TOOL_SAFETY

    specs = []
    for block in exposed_tools():
        spec = spec_from_block(block).to_dict()
        safe = TOOL_SAFETY.get(block.name, False)
        # MCP's behaviour hints: a safe tool changes only what the window shows.
        spec["annotations"] = {"readOnlyHint": safe, "destructiveHint": False, "openWorldHint": False}
        if not safe:
            spec["description"] += " Each call is approved by the user in the OpalaTex window."
        specs.append(spec)
    return specs


def _project_key(path: str) -> str:
    from .ide_control import _project_key as key

    return key(path)


async def _ask_window(tool: str, arguments: dict, project_path: str, bus) -> str:
    """The user's answer in the window: "yes", "always" or "no"."""
    from .ide_control import IdeCommandError, WindowChannel, send_ide_command, use_command_channel

    with use_command_channel(WindowChannel(bus)):
        try:
            answer = await send_ide_command(
                "request_approval",
                {"tool": tool, "arguments": arguments, "timeout_ms": int(APPROVAL_TIMEOUT * 1000)},
                project_path=project_path,
                timeout=APPROVAL_TIMEOUT + APPROVAL_MARGIN,
            )
        except IdeCommandError:
            return "no"
    value = str(answer.get("answer") or "").strip().lower()
    return value if value in ("yes", "always") else "no"


async def call(tool: str, arguments: dict | None, project_path: str, *, bus=None) -> MCPToolResult:
    """Run one exposed tool for an external agent, on *project_path*.

    The project must be open in a window that listens for external commands,
    and the arguments must fit the tool; the call is refused otherwise, before
    anything is asked or run. A tool that is not safe is then approved in the
    window.
    """
    from .ide_control import WINDOW_BUS, WindowChannel, use_command_channel
    from .tools import TOOL_SAFETY, external_call_approved, project_path_for_call

    bus = bus or WINDOW_BUS
    arguments = dict(arguments or {})
    block = next((b for b in exposed_tools() if b.name == tool), None)
    if block is None:
        names = ", ".join(b.name for b in exposed_tools())
        return MCPToolResult(content=[f"Unknown tool '{tool}'. Tools: {names}."], is_error=True)
    if not str(project_path or "").strip():
        return MCPToolResult(content=["The call names no project."], is_error=True)
    if bus.find(project_path) is None:
        return MCPToolResult(content=[
            f"No OpalaTex window has the project {project_path} open with external agent access "
            "turned on. Ask the user to open it in OpalaTex."
        ], is_error=True)
    invalid = validate_block_arguments(block, arguments)
    if invalid:
        return MCPToolResult(content=[invalid], is_error=True)

    if not TOOL_SAFETY.get(tool, False):
        key = (_project_key(project_path), tool)
        if key not in _ALWAYS_ALLOWED:
            answer = await _ask_window(tool, arguments, project_path, bus)
            if answer == "no":
                return MCPToolResult(content=[
                    f"The user did not approve '{tool}' in the OpalaTex window (declined, or no "
                    "answer). Do not retry it unless the user asks you to."
                ], is_error=True)
            if answer == "always":
                _ALWAYS_ALLOWED.add(key)

    with project_path_for_call(project_path), use_command_channel(WindowChannel(bus)), external_call_approved():
        return await call_block(block, arguments)
