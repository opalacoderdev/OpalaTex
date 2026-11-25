"""External agents over MCP, phase 2 (docs/specs/external_agents.md).

The catalog and a call on the instance (`external_agent_tools`), the
credential boundary of `/api/external/*`, the stdio server `opalatex mcp`
(`external_mcp`), and end to end: the SDK's real client starts `opalatex mcp`
as a subprocess, which finds a real server on a loopback port and drives a
window connected to it.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from agenticblocks.tools.mcp_client import MCPClientBridge
from opalatex import external_access, external_agent_tools, external_mcp, tools
from opalatex.ide_control import WINDOW_BUS, WindowBus, resolve_ide_command
from opalatex.tools import get_ide_control_tools

ROOT = Path(__file__).resolve().parent.parent
IDE_TOOL_NAMES = ["open_file", "close_file", "reveal_in_pdf", "set_layout", "get_problems", "read_terminal"]
EXTERNAL_TOOL_NAMES = [*IDE_TOOL_NAMES, "get_window_state", "compile_latex"]


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("OPALATEX_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    (root / "chapters").mkdir(parents=True)
    (root / "main.tex").write_text("one\ntwo\nthree\n", encoding="utf-8")
    (root / "chapters" / "intro.tex").write_text("intro\n", encoding="utf-8")
    return root


def _answer_window(connection, answer):
    """A task that plays the window: answers every command on *connection*."""
    seen = []

    async def run():
        while True:
            payload = await connection.queue.get()
            if payload is None:
                return
            seen.append(payload)
            if payload.get("event") == "ide_command":  # events are only shown, never answered
                resolve_ide_command(payload["id"], answer(payload))

    return seen, asyncio.create_task(run())


# ── The catalog and a call on the instance ───────────────────────────────────

def test_catalog_is_the_built_in_agents_ide_tools_and_the_live_window_state():
    catalog = external_agent_tools.catalog()
    assert [spec["name"] for spec in catalog] == EXTERNAL_TOOL_NAMES
    # The built-in agent's own list is unchanged: it keeps get_editor_state.
    assert [b.name for b in get_ide_control_tools()] == IDE_TOOL_NAMES
    open_file = catalog[0]
    assert open_file["input_schema"]["required"] == ["path"]
    assert "title" not in open_file["input_schema"]
    assert open_file["description"] == get_ide_control_tools()[0].description


def test_a_call_runs_the_tool_on_its_own_project_through_the_window(project, monkeypatch):
    monkeypatch.setattr(tools, "_PROJECT_PATH", "/somewhere/else/the/turn/bound")

    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(project))
        seen, answering = _answer_window(window, lambda p: {
            "ok": True, "open_files": [p["args"]["path"]], "current_file": p["args"]["path"]})
        result = await external_agent_tools.call(
            "open_file", {"path": "chapters/intro.tex", "line": 1}, str(project), bus=bus)
        bus.disconnect(window)
        await answering
        return seen, result

    seen, result = asyncio.run(scenario())
    assert not result.is_error, result.content
    assert result.content[0].startswith("Opened `chapters/intro.tex` in the editor as the focused tab, scrolled to line 1.")
    assert [(p["action"], p["args"], p["project_path"]) for p in seen] == [
        ("open_file", {"path": "chapters/intro.tex", "line": 1, "focus": True}, str(project))]
    # The turn's globals are untouched, and the call's project ends with the call.
    assert tools._PROJECT_PATH == "/somewhere/else/the/turn/bound"
    assert tools.get_project_path() == "/somewhere/else/the/turn/bound"


def test_window_state_is_read_live_from_the_window(project):
    answers = {
        False: {"ok": True, "open_files": ["main.tex", "chapters/intro.tex"], "current_file": "main.tex",
                "unsaved": True, "cursor": {"line": 2, "column": 4},
                "selection": {"text": "two", "start_line": 2, "end_line": 2}, "content_chars": 14},
        True: {"ok": True, "open_files": ["main.tex"], "current_file": "main.tex", "unsaved": False,
               "cursor": None, "selection": None, "content_chars": 14, "content": "one\ntwo\nthree\n"},
    }

    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(project))
        seen, answering = _answer_window(window, lambda p: answers[p["args"]["include_content"]])
        brief = await external_agent_tools.call("get_window_state", {}, str(project), bus=bus)
        full = await external_agent_tools.call("get_window_state", {"include_content": True}, str(project), bus=bus)
        bus.disconnect(window)
        await answering
        return seen, brief, full

    seen, brief, full = asyncio.run(scenario())
    assert [p["action"] for p in seen] == ["get_editor_state", "get_editor_state"]
    assert brief.content[0] == "\n".join([
        "## OpalaTex window",
        "- **Open tabs (2)**: `main.tex` (focused), `chapters/intro.tex`",
        "- **Focused file**: `main.tex` — has unsaved edits",
        "- **Cursor**: line 2, column 4",
        "\n### Selected text (lines 2–2, 3 chars)\n```\ntwo\n```",
        "- **Live buffer**: 14 chars — call get_window_state(include_content=true) to read it.",
    ])
    assert "### Live buffer of `main.tex` (14 chars; may differ from the file on disk)\n```\none\ntwo\nthree\n\n```" in full.content[0]
    assert "- **Selection**: (nothing selected)" in full.content[0]


def test_a_call_is_refused_before_any_tool_runs_without_a_window_on_the_project(project):
    async def scenario():
        bus = WindowBus()
        bus.connect("w1", str(project.parent / "other"))
        return await external_agent_tools.call("set_layout", {"layout": "chat"}, str(project), bus=bus)

    result = asyncio.run(scenario())
    assert result.is_error
    assert "No OpalaTex window has the project" in result.content[0]


def test_tool_errors_and_invalid_arguments_are_tool_errors(project):
    async def scenario():
        bus = WindowBus()
        bus.connect("w1", str(project))
        return [
            await external_agent_tools.call("open_file", {"path": "missing.tex"}, str(project), bus=bus),
            await external_agent_tools.call("open_file", {"line": 3}, str(project), bus=bus),
            await external_agent_tools.call("open_file", {"path": "../outside.tex"}, str(project), bus=bus),
            await external_agent_tools.call("write_file", {}, str(project), bus=bus),
        ]

    missing, invalid, outside, unknown = asyncio.run(scenario())
    assert missing.is_error and "file not found" in missing.content[0]
    assert invalid.is_error and invalid.content[0].startswith("Invalid arguments: path:")
    assert outside.is_error and "outside the project" in outside.content[0]
    assert unknown.is_error and unknown.content[0].startswith("Unknown tool 'write_file'.")


# ── Choosing the instance and project (opalatex mcp) ─────────────────────────

def test_the_innermost_open_project_containing_the_directory_is_chosen(tmp_path):
    a, b = {"url": "a"}, {"url": "b"}
    outer, inner = str(tmp_path / "work"), str(tmp_path / "work" / "thesis")
    choices = [(a, outer), (b, inner)]
    assert external_mcp.choose_project(str(tmp_path / "work" / "thesis" / "ch1"), choices) == (b, inner)
    assert external_mcp.choose_project(str(tmp_path / "work" / "notes"), choices) == (a, outer)
    assert external_mcp.choose_project(str(tmp_path / "workshop"), choices) is None
    assert external_mcp.choose_project(str(tmp_path), choices) is None


def test_without_an_instance_the_server_exits_with_what_to_do(home, project):
    completed = subprocess.run(
        [sys.executable, str(ROOT / "main.py"), "mcp"],
        cwd=project, env=dict(os.environ, OPALATEX_HOME=str(home)),
        capture_output=True, text=True, timeout=60,
    )
    assert completed.returncode == 1
    assert completed.stdout == ""  # stdout belongs to the protocol
    assert "OpalaTex is not running with external agent access turned on" in completed.stderr


# ── A real server: credentials and end to end ────────────────────────────────

async def _request(server, method, path, *, cookie=False, token=None, body=None):
    reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
    payload = json.dumps(body).encode() if body is not None else b""
    head = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{server.port}\r\nContent-Length: {len(payload)}\r\n"
    if cookie:
        head += f"Cookie: {server.local_session.cookie_name}={server.local_session.token}\r\n"
    if token:
        head += f"Authorization: Bearer {token}\r\n"
    writer.write((head + "\r\n").encode() + payload)
    await writer.drain()
    raw = await reader.read()
    writer.close()
    return int(raw.split(b" ", 2)[1]), json.loads(raw.split(b"\r\n\r\n", 1)[1] or b"null")


async def _started_server():
    from opalatex.ide_server import AsyncHTTPServer

    server = AsyncHTTPServer(port=0)
    await server.start()
    return server


async def _stopped(server):
    server.stop()
    server.server.close()
    await server.server.wait_closed()
    WINDOW_BUS.close_all()


def test_each_credential_opens_only_its_own_endpoints(home):
    async def scenario():
        server = await _started_server()
        token = server.external_access.token
        try:
            # Off: the token is not accepted anywhere.
            assert (await _request(server, "GET", "/api/external/tools", token=token))[0] == 401
            server.external_access.publish()
            status, body = await _request(server, "GET", "/api/external/tools", token=token)
            assert status == 200 and [t["name"] for t in body["tools"]] == EXTERNAL_TOOL_NAMES
            assert body["instructions"] == external_agent_tools.SERVER_INSTRUCTIONS
            # The window's cookie does not open the external endpoints ...
            assert (await _request(server, "GET", "/api/external/tools", cookie=True))[0] == 401
            assert (await _request(server, "GET", "/api/external/tools", token="wrong"))[0] == 401
            # ... and the token does not open the window's API.
            assert (await _request(server, "GET", "/api/settings/external-access", token=token))[0] == 401
            assert (await _request(server, "GET", "/api/settings/external-access", cookie=True))[0] == 200
            assert (await _request(server, "POST", "/api/external/call", token=token, body=["x"]))[0] == 400
            assert (await _request(server, "GET", "/api/external/nothing", token=token))[0] == 404
        finally:
            await _stopped(server)

    asyncio.run(scenario())


def test_end_to_end_a_real_mcp_client_drives_the_window(home, project, tmp_path):
    external_access.save_config({"enabled": True})
    subdir = project / "chapters"

    async def scenario():
        server = await _started_server()
        window = WINDOW_BUS.connect("w1", str(project))
        seen, answering = _answer_window(window, lambda p: (
            {"ok": True, "layout": p["args"]["layout"]} if p["action"] == "set_layout"
            else {"ok": True, "open_files": ["main.tex"], "current_file": "main.tex"}))
        client = MCPClientBridge(
            command=sys.executable, args=[str(ROOT / "main.py"), "mcp"],
            env=dict(os.environ, OPALATEX_HOME=str(home)), cwd=str(subdir),
        )
        try:
            status, windows = await _request(server, "GET", "/api/external/windows", token=server.external_access.token)
            assert windows == {"windows": [{"project_path": str(project)}]}
            await client.open()
            specs = await client.list_tools()
            opened = await client.call_tool("open_file", {"path": "main.tex", "line": 2})
            layout = await client.call_tool("set_layout", {"layout": "chat"})
            refused = await client.call_tool("set_layout", {"layout": "nonsense"})
        finally:
            await client.disconnect()
            await _stopped(server)
            await answering
        return specs, opened, layout, refused, seen

    specs, opened, layout, refused, seen = asyncio.run(scenario())
    assert [s.name for s in specs] == EXTERNAL_TOOL_NAMES
    assert not opened.is_error, opened.content
    assert opened.content[0].startswith("Opened `main.tex` in the editor as the focused tab, scrolled to line 2.")
    assert layout.content == ["The IDE window is now in the `chat` layout: the conversation fills the window; the editor is hidden."]
    assert refused.is_error and "unknown layout" in refused.content[0]
    # Only the valid commands reached the window, each for the project the CLI started in.
    assert [(p["action"], p["project_path"]) for p in seen] == [
        ("open_file", str(project)), ("set_layout", str(project))]


# ── Approval of tools that are not safe (compile_latex) ──────────────────────

@pytest.fixture
def latex_project(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from opalatex import latex_compiler

    root = tmp_path / "thesis"
    root.mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}x\\end{document}\n", encoding="utf-8")
    calls = []

    def compile_latex(content, file_path=None, main_file="", project_dir="", **kwargs):
        calls.append({"main_file": main_file, "project_dir": project_dir})
        return {"success": True, "pdf_path": os.path.join(project_dir, "main.pdf"), "log": "ok", "timing": {"compile_seconds": 0.5}}

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "/opt/tectonic")
    monkeypatch.setattr(latex_compiler, "compile_latex", compile_latex)
    monkeypatch.setattr("opalatex.project.stored_main_file", lambda path: "")
    external_agent_tools.forget_approvals()
    yield SimpleNamespace(root=root, calls=calls)
    external_agent_tools.forget_approvals()


def _approving_window(connection, answers):
    """Plays the window: answers approvals from *answers* in order, keeps every payload."""
    def answer(payload):
        assert payload["action"] == "request_approval"
        return {"ok": True, "answer": answers.pop(0)}
    return _answer_window(connection, answer)


def _run_calls(project, answers, calls_args):
    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(project))
        seen, answering = _approving_window(window, answers)
        results = [await external_agent_tools.call(tool, args, str(project), bus=bus) for tool, args in calls_args]
        await asyncio.sleep(0.05)  # let the compile's window event arrive
        bus.disconnect(window)
        await answering
        return seen, results

    return asyncio.run(scenario())


def test_catalog_marks_which_tools_need_approval():
    specs = {spec["name"]: spec for spec in external_agent_tools.catalog()}
    assert specs["compile_latex"]["annotations"]["readOnlyHint"] is False
    assert specs["compile_latex"]["description"].endswith("Each call is approved by the user in the OpalaTex window.")
    assert specs["open_file"]["annotations"]["readOnlyHint"] is True
    assert "approved" not in specs["open_file"]["description"]


def test_a_declined_compile_does_not_run(latex_project):
    seen, [result] = _run_calls(latex_project.root, ["no"], [("compile_latex", {})])
    assert result.is_error and "did not approve 'compile_latex'" in result.content[0]
    assert latex_project.calls == []
    assert [(p["action"], p["args"]["tool"], p["args"]["arguments"]) for p in seen] == [
        ("request_approval", "compile_latex", {})]


def test_an_approved_compile_runs_on_its_project_and_shows_in_the_window(latex_project):
    seen, [result] = _run_calls(latex_project.root, ["yes"], [("compile_latex", {"draft": True})])
    assert not result.is_error, result.content
    assert result.content[0].startswith("SUCCESS: main.tex compiled (draft pass in 0.5s, Tectonic). PDF: main.pdf")
    assert latex_project.calls == [{"main_file": "main.tex", "project_dir": str(latex_project.root)}]
    # The window got the approval request, then the compile's outcome (from the
    # tool's worker thread), as the built-in agent's turn stream would carry it.
    assert [p["event"] for p in seen] == ["ide_command", "latex_compiled"]
    compiled = seen[1]
    assert (compiled["project_path"], compiled["main_file"], compiled["success"], compiled["draft"]) == (
        str(latex_project.root), "main.tex", True, True)


def test_always_is_remembered_per_tool_and_project_until_forgotten(latex_project):
    seen, results = _run_calls(latex_project.root, ["always"], [("compile_latex", {}), ("compile_latex", {})])
    assert [r.is_error for r in results] == [False, False]
    assert [p["action"] for p in seen if p["event"] == "ide_command"] == ["request_approval"]
    external_agent_tools.forget_approvals()
    seen, [result] = _run_calls(latex_project.root, ["no"], [("compile_latex", {})])
    assert result.is_error and [p["action"] for p in seen if p["event"] == "ide_command"] == ["request_approval"]


def test_invalid_arguments_are_refused_before_asking(latex_project):
    seen, [result] = _run_calls(latex_project.root, [], [("compile_latex", {"draft": "maybe"})])
    assert result.is_error and result.content[0].startswith("Invalid arguments: draft:")
    assert seen == [] and latex_project.calls == []


def test_an_unanswered_approval_is_a_refusal(latex_project, monkeypatch):
    monkeypatch.setattr(external_agent_tools, "APPROVAL_TIMEOUT", 0.1)
    monkeypatch.setattr(external_agent_tools, "APPROVAL_MARGIN", 0.1)

    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(latex_project.root))  # receives the request, never answers
        result = await asyncio.wait_for(
            external_agent_tools.call("compile_latex", {}, str(latex_project.root), bus=bus), 10)
        request = window.queue.get_nowait()
        bus.disconnect(window)
        return result, request

    result, request = asyncio.run(scenario())
    assert result.is_error and "did not approve" in result.content[0]
    assert request["action"] == "request_approval" and request["args"]["timeout_ms"] == 100
    assert latex_project.calls == []


def test_the_external_gate_does_not_touch_the_built_in_agents_mode(latex_project):
    """The built-in agent in plan mode is still blocked; an approved external call is not
    subject to that turn's mode, nor does it change it."""
    from types import SimpleNamespace
    from opalatex.tools import compile_latex, set_project_context

    session = SimpleNamespace(project_path=str(latex_project.root), mode="plan", main_file="")
    set_project_context(session)
    blocked = asyncio.run(compile_latex._func())
    assert blocked.startswith("Execution blocked: In 'plan' mode")
    assert latex_project.calls == []

    _, [result] = _run_calls(latex_project.root, ["yes"], [("compile_latex", {})])
    assert not result.is_error
    assert session.mode == "plan" and not getattr(session, "results", None)
    assert asyncio.run(compile_latex._func()).startswith("Execution blocked: In 'plan' mode")


def test_the_built_in_compile_still_reports_on_the_turn_stream(latex_project, monkeypatch):
    from types import SimpleNamespace
    from opalatex import agent_stdin
    from opalatex.tools import compile_latex, set_project_context

    events = []
    monkeypatch.setattr(agent_stdin, "event_hook", events.append)
    set_project_context(SimpleNamespace(project_path=str(latex_project.root), mode="auto", main_file="main.tex"))
    result = asyncio.run(compile_latex._func())
    assert result.startswith("SUCCESS: main.tex compiled")
    assert [e["event"] for e in events if e.get("event") == "latex_compiled"] == ["latex_compiled"]


def test_an_external_compile_uses_the_main_file_stored_for_its_project(latex_project, monkeypatch, tmp_path):
    """Not the main file of the session the built-in agent's last turn bound."""
    from types import SimpleNamespace
    from opalatex.tools import set_project_context

    (latex_project.root / "book.tex").write_text("\\documentclass{book}\n", encoding="utf-8")
    other = tmp_path / "other"
    other.mkdir()
    set_project_context(SimpleNamespace(project_path=str(other), mode="auto", main_file="elsewhere.tex"))
    monkeypatch.setattr("opalatex.project.stored_main_file", lambda path: "book.tex" if path == str(latex_project.root) else "")
    _, [result] = _run_calls(latex_project.root, ["yes"], [("compile_latex", {})])
    assert not result.is_error, result.content
    assert latex_project.calls == [{"main_file": "book.tex", "project_dir": str(latex_project.root)}]


def test_end_to_end_an_approved_compile_through_opalatex_mcp(home, latex_project):
    external_access.save_config({"enabled": True})

    async def scenario():
        server = await _started_server()
        window = WINDOW_BUS.connect("w1", str(latex_project.root))
        seen, answering = _answer_window(window, lambda p: {"ok": True, "answer": "yes"})
        client = MCPClientBridge(
            command=sys.executable, args=[str(ROOT / "main.py"), "mcp"],
            env=dict(os.environ, OPALATEX_HOME=str(home)), cwd=str(latex_project.root),
        )
        try:
            await client.open()
            compiled = await client.call_tool("compile_latex", {})
        finally:
            await client.disconnect()
            await _stopped(server)
            await answering
        return compiled, seen

    compiled, seen = asyncio.run(scenario())
    assert not compiled.is_error, compiled.content
    assert compiled.content[0].startswith("SUCCESS: main.tex compiled")
    assert [(p["event"], p.get("action")) for p in seen] == [
        ("ide_command", "request_approval"), ("latex_compiled", None)]
