"""Checkpoints of an external agent's turns (opalatex/external_turns.py).

Claude Code's hooks run `opalatex agent-hook` at the start and end of each of
its turns; OpalaTex then takes the same shadow-Git checkpoints as for its own
turns, labelled "Claude Code", so Review shows the turn and can undo it.
"""

import asyncio
import io
import json
import os
import subprocess
import sys

import pytest

from opalatex import agent_clis, agent_hook, external_access
from opalatex.external_turns import ExternalTurns
from opalatex.ide_control import WindowBus

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("OPALATEX_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setattr("opalatex.config.get_git_strategy", lambda: "hybrid")
    return tmp_path / "home"


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "main.tex").write_text("one\n", encoding="utf-8")
    return root


def _subjects(project):
    from opalatex.vcs import _run_shadow_git

    log = _run_shadow_git(["log", "--format=%s"], str(project))
    return log.stdout.split("\n")[:-1] if log.returncode == 0 else []


def _drain(connection):
    events = []
    while not connection.queue.empty():
        events.append(connection.queue.get_nowait())
    return events


def _scenario(project, steps):
    """Run *steps(turns, window)* with a window open on *project*."""
    async def run():
        bus = WindowBus()
        window = bus.connect("w1", str(project))
        turns = ExternalTurns(bus)
        try:
            return await steps(turns, window)
        finally:
            bus.disconnect(window)

    return asyncio.run(run())


# ── The turns ────────────────────────────────────────────────────────────────

def test_a_turn_that_changes_files_is_kept_and_reported_to_the_window(home, project):
    async def steps(turns, window):
        status, started = await turns.handle("turn-start", "claude", "s1", str(project))
        assert status == 200 and started["checkpoint"]
        (project / "main.tex").write_text("one\ntwo\n", encoding="utf-8")
        (project / "new.tex").write_text("new\n", encoding="utf-8")
        status, ended = await turns.handle("turn-end", "claude", "s1", str(project))
        assert status == 200
        assert ended["closed"] == {"saved": True, "changed_files": ["main.tex", "new.tex"]}
        return _drain(window)

    events = _scenario(project, steps)
    assert _subjects(project)[:2] == [
        "Agent turn end checkpoint: Claude Code", "Agent turn start checkpoint: Claude Code"]
    assert events == [{
        "event": "checkpoint_finalized", "agent": "Claude Code", "external": True, "success": True,
        "changed_files": ["main.tex", "new.tex"], "project_path": str(project),
    }]


def test_a_turn_that_changes_nothing_leaves_no_checkpoint(home, project):
    async def steps(turns, window):
        await turns.handle("turn-start", "claude", "s1", str(project))
        await turns.handle("turn-end", "claude", "s1", str(project))

    _scenario(project, steps)
    assert not any("Claude Code" in subject for subject in _subjects(project))


def test_an_interrupted_turn_is_closed_by_the_next_prompt(home, project):
    """Claude Code runs no Stop hook when the user interrupts the response."""
    async def steps(turns, window):
        await turns.handle("turn-start", "claude", "s1", str(project))
        (project / "main.tex").write_text("interrupted\n", encoding="utf-8")
        status, second = await turns.handle("turn-start", "claude", "s1", str(project))
        assert second["closed"]["changed_files"] == ["main.tex"]
        (project / "main.tex").write_text("second\n", encoding="utf-8")
        await turns.handle("session-end", "claude", "s1", str(project))
        assert turns.open_turns() == []

    _scenario(project, steps)
    assert [s for s in _subjects(project) if "Claude Code" in s] == [
        "Agent turn end checkpoint: Claude Code", "Agent turn start checkpoint: Claude Code",
        "Agent turn end checkpoint: Claude Code", "Agent turn start checkpoint: Claude Code",
    ]


def test_sessions_have_turns_of_their_own(home, project):
    async def steps(turns, window):
        await turns.handle("turn-start", "claude", "s1", str(project))
        await turns.handle("turn-start", "claude", "s2", str(project))
        assert len(turns.open_turns()) == 2
        status, ended = await turns.handle("turn-end", "claude", "s1", str(project))
        assert ended["closed"] is not None and len(turns.open_turns()) == 1
        await turns.close_all()
        assert turns.open_turns() == []

    _scenario(project, steps)


def test_an_end_without_a_start_changes_nothing(home, project):
    async def steps(turns, window):
        return await turns.handle("turn-end", "claude", "s1", str(project))

    assert _scenario(project, steps) == (200, {"ok": True, "closed": None})
    assert _subjects(project) == []


@pytest.mark.parametrize("event, agent, session, error", [
    ("turn-begin", "claude", "s1", "Unknown event"),
    ("turn-start", "antigravity", "s1", "Unknown agent"),
    ("turn-start", "claude", "", "session id"),
    ("turn-start", "claude", "x" * 201, "session id"),
])
def test_malformed_requests_are_refused(home, project, event, agent, session, error):
    async def steps(turns, window):
        return await turns.handle(event, agent, session, str(project))

    status, payload = _scenario(project, steps)
    assert status == 400 and error in payload["error"]
    assert _subjects(project) == []


def test_a_project_without_a_window_is_not_checkpointed(home, project):
    async def run():
        return await ExternalTurns(WindowBus()).handle("turn-start", "claude", "s1", str(project))

    status, payload = asyncio.run(run())
    assert status == 409 and "No OpalaTex window has the project" in payload["error"]
    assert _subjects(project) == []


def test_the_none_git_strategy_takes_no_checkpoint(home, project, monkeypatch):
    monkeypatch.setattr("opalatex.config.get_git_strategy", lambda: "none")

    async def steps(turns, window):
        return await turns.handle("turn-start", "claude", "s1", str(project))

    status, payload = _scenario(project, steps)
    assert status == 200 and payload["checkpoint"] is None
    assert _subjects(project) == []


# ── Claude Code's session settings ───────────────────────────────────────────

def test_claude_code_hooks_run_agent_hook_at_each_turn_boundary():
    settings = agent_clis.claude_hook_settings(lambda event: ["/opt/OpalaTex", "agent-hook", event, "--agent", "claude"])
    hooks = settings["hooks"]
    assert set(hooks) == {"UserPromptSubmit", "Stop", "SessionEnd"}
    for claude_event, event in agent_clis.CLAUDE_HOOK_EVENTS.items():
        [group] = hooks[claude_event]
        assert "matcher" not in group
        [hook] = group["hooks"]
        assert hook == {
            "type": "command",
            "command": f"/opt/OpalaTex agent-hook {event} --agent claude",
            "timeout": agent_clis.CLAUDE_HOOK_TIMEOUTS[claude_event],
        }


def test_a_hook_command_is_quoted_for_its_shell():
    argv = ["/home/me/My Apps/OpalaTex", "agent-hook", "turn-start"]
    assert agent_clis.claude_hook_command_line(argv, windows=False) == "'/home/me/My Apps/OpalaTex' agent-hook turn-start"
    assert agent_clis.claude_hook_command_line(
        ["C:\\Program Files\\OpalaTex\\OpalaTex.exe", "agent-hook"], windows=True,
    ) == '"C:\\Program Files\\OpalaTex\\OpalaTex.exe" agent-hook'


def test_claude_code_is_started_with_the_hooks_for_its_session_only(home):
    argv = agent_clis.launch_argv(
        agent_clis.AGENT_CLIS["claude"], "/usr/bin/claude", ["/opt/OpalaTex", "mcp"],
        hook_command=lambda event: external_access.agent_hook_command(event, "claude"),
    )
    assert argv[:2] == ["/usr/bin/claude", "--mcp-config"]
    assert argv[3] == "--settings"
    written = json.loads(open(argv[4], encoding="utf-8").read())
    command = written["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert command.endswith("agent-hook turn-start --agent claude")
    assert argv[4] == str(agent_clis.claude_settings_path())


def test_the_hook_command_is_this_installation_running_agent_hook(monkeypatch):
    monkeypatch.delenv("SNAP", raising=False)
    assert external_access.agent_hook_command("turn-end", "claude") == [
        *external_access.opalatex_command(), "agent-hook", "turn-end", "--agent", "claude"]
    assert external_access.mcp_command() == [*external_access.opalatex_command(), "mcp"]


# ── `opalatex agent-hook` ────────────────────────────────────────────────────

def test_agent_hook_forwards_the_turn_and_prints_nothing(monkeypatch, capsys, tmp_path):
    sent = []
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setattr("opalatex.external_mcp.resolve", lambda path: ({"url": "u", "token": "t"}, path))
    monkeypatch.setattr("opalatex.external_mcp._request", lambda instance, method, path, body, timeout: sent.append((method, path, body)) or {})
    hook = json.dumps({"session_id": "abc", "cwd": str(tmp_path), "hook_event_name": "UserPromptSubmit", "prompt": "hi"})

    assert agent_hook.main(["turn-start", "--agent", "claude"], stdin=io.StringIO(hook)) == 0
    assert sent == [("POST", "/api/external/turn", {
        "event": "turn-start", "agent": "claude", "session": "abc", "project_path": str(tmp_path)})]
    assert capsys.readouterr().out == ""


def test_agent_hook_prefers_claude_project_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path / "root"))
    assert agent_hook.project_dir({"cwd": str(tmp_path / "root" / "sub")}) == str(tmp_path / "root")


def test_agent_hook_failures_are_not_blocking(monkeypatch, capsys):
    from opalatex.external_mcp import InstanceError

    def unreachable(path):
        raise InstanceError("OpalaTex is not running with external agent access turned on.")

    monkeypatch.setattr("opalatex.external_mcp.resolve", unreachable)
    assert agent_hook.main(["turn-end", "--agent", "claude"], stdin=io.StringIO('{"session_id": "abc"}')) == 1
    assert agent_hook.main(["turn-end", "--agent", "claude"], stdin=io.StringIO("not json")) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "opalatex agent-hook: OpalaTex is not running" in out.err
    assert "no session_id" in out.err


# ── End to end: the server and the real command ──────────────────────────────

def test_agent_hook_end_to_end_with_a_running_opalatex(home, project):
    """`main.py agent-hook`, as Claude Code's hooks run it, against a real server."""
    from opalatex.ide_control import WINDOW_BUS
    from opalatex.ide_server import AsyncHTTPServer

    external_access.save_config({"enabled": True})
    env = {key: value for key, value in os.environ.items() if key != "CLAUDE_PROJECT_DIR"}

    def hook(event):
        return subprocess.run(
            [sys.executable, os.path.join(_REPO_ROOT, "main.py"), "agent-hook", event, "--agent", "claude"],
            input=json.dumps({"session_id": "e2e", "cwd": str(project)}),
            capture_output=True, text=True, cwd=str(project), env=env, timeout=120,
        )

    async def scenario():
        server = AsyncHTTPServer(port=0)
        await server.start()
        window = WINDOW_BUS.connect("w-e2e", str(project))
        try:
            started = await asyncio.to_thread(hook, "turn-start")
            (project / "main.tex").write_text("changed by the agent\n", encoding="utf-8")
            ended = await asyncio.to_thread(hook, "turn-end")
            await asyncio.sleep(0.05)
            return started, ended, _drain(window)
        finally:
            WINDOW_BUS.disconnect(window)
            server.stop()
            server.server.close()
            await server.server.wait_closed()

    started, ended, events = asyncio.run(scenario())
    assert (started.returncode, started.stdout) == (0, ""), started.stderr
    assert (ended.returncode, ended.stdout) == (0, ""), ended.stderr
    assert _subjects(project)[:2] == [
        "Agent turn end checkpoint: Claude Code", "Agent turn start checkpoint: Claude Code"]
    assert [e["event"] for e in events] == ["checkpoint_finalized"]
    assert events[0]["changed_files"] == ["main.tex"]


def test_the_turn_endpoint_takes_the_external_token_only(home, project):
    from opalatex.ide_server import AsyncHTTPServer

    external_access.save_config({"enabled": True})

    async def scenario():
        server = AsyncHTTPServer(port=0)
        await server.start()
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
            body = json.dumps({"event": "turn-start", "agent": "claude", "session": "s", "project_path": str(project)})
            writer.write((f"POST /api/external/turn HTTP/1.1\r\nHost: 127.0.0.1:{server.port}\r\nContent-Type: application/json\r\n"
                          f"Content-Length: {len(body)}\r\n\r\n{body}").encode())
            await writer.drain()
            status_line = await reader.readline()
            writer.close()
            return status_line
        finally:
            server.stop()
            server.server.close()
            await server.server.wait_closed()

    assert b" 401 " in asyncio.run(scenario())
    assert _subjects(project) == []
