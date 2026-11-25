"""Opening a coding agent's CLI in a terminal tab, connected to `opalatex mcp`
(opalatex/agent_clis.py; docs/specs/external_agents.md, phase 3).

The CLIs are stand-ins (shell scripts), so nothing here starts a real agent or
touches the user's own configuration: HOME and OPALATEX_HOME point into tmp.
"""

import asyncio
import json
import os
import stat
import sys

import pytest

from opalatex import agent_clis, external_access
from opalatex.agent_clis import AGENT_CLIS, AgentCliError

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the stand-in CLIs are POSIX shell scripts")

CLAUDE = AGENT_CLIS["claude"]
AGY = AGENT_CLIS["antigravity"]
COMMAND = ["/usr/bin/python3", "/opt/opalatex/main.py", "mcp"]


@pytest.fixture
def home(tmp_path, monkeypatch):
    user_home = tmp_path / "user"
    user_home.mkdir()
    monkeypatch.setenv("HOME", str(user_home))
    monkeypatch.setenv("OPALATEX_HOME", str(tmp_path / "opalatex-home"))
    monkeypatch.delenv("SNAP", raising=False)
    return user_home


def _script(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


# ── Finding the CLI ──────────────────────────────────────────────────────────

def test_the_cli_is_found_on_the_path_the_terminal_shell_builds(home, monkeypatch):
    """A directory only ~/.bashrc puts on PATH (as installers do) is searched."""
    _script(home / "agentbin" / "claude", "exit 0\n")
    (home / ".bashrc").write_text('export PATH="$HOME/agentbin:$PATH"\n', encoding="utf-8")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    assert agent_clis.find_cli(CLAUDE) == str(home / "agentbin" / "claude")
    assert agent_clis.find_cli(AGY) is None


def test_not_found_says_what_to_do_and_mentions_the_snap_only_there(monkeypatch):
    monkeypatch.delenv("SNAP", raising=False)
    message = agent_clis.not_found_message(AGY)
    assert "no `agy` command on the PATH of the integrated terminal" in message
    assert "snap" not in message
    monkeypatch.setenv("SNAP", "/snap/opalatex/1")
    assert "snap's confinement" in agent_clis.not_found_message(AGY)


# ── Configuration ────────────────────────────────────────────────────────────

def test_claude_gets_a_session_config_file_in_opalatex_home(home):
    argv = agent_clis.launch_argv(CLAUDE, "/bin/claude", COMMAND)
    path = agent_clis.claude_mcp_config_path()
    assert argv == ["/bin/claude", "--mcp-config", str(path)]
    assert str(path).startswith(os.environ["OPALATEX_HOME"])
    assert json.loads(path.read_text(encoding="utf-8")) == {"mcpServers": {"opalatex": {
        "type": "stdio", "command": "/usr/bin/python3", "args": ["/opt/opalatex/main.py", "mcp"]}}}
    assert not (home / ".claude").exists() and not (home / ".claude.json").exists()


def _agy_config(home, document):
    path = home / ".gemini" / "config" / "mcp_config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")


def test_antigravity_registration_states(home):
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "missing"
    _agy_config(home, "")
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "missing"
    _agy_config(home, {"mcpServers": {"other": {"command": "x"}}})
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "missing"
    entry = {"command": COMMAND[0], "args": COMMAND[1:], "disabled": False}
    _agy_config(home, {"mcpServers": {"opalatex": entry}})
    assert agent_clis.antigravity_registration(COMMAND) == {"state": "registered", "current": entry}
    _agy_config(home, {"mcpServers": {"opalatex": {**entry, "disabled": True}}})
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "different"
    _agy_config(home, {"mcpServers": {"opalatex": {**entry, "args": ["/old/main.py", "mcp"]}}})
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "different"
    _agy_config(home, "{broken")
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "different"


def _fake_agy(home, *, writes=True, exit_code=0):
    """An `agy` that records its arguments and, like the real one, writes the entry."""
    record = home / "agy-calls.txt"
    config = home / ".gemini" / "config" / "mcp_config.json"
    body = f'echo "$@" >> "{record}"\n'
    if writes:
        body += (
            f'mkdir -p "{config.parent}"\n'
            f"cat > \"{config}\" <<'JSON'\n"
            + json.dumps({"mcpServers": {"opalatex": {"command": COMMAND[0], "args": COMMAND[1:], "disabled": False}}})
            + "\nJSON\n"
        )
    body += f"exit {exit_code}\n"
    return _script(home / "bin" / "agy", body), record


def test_registration_runs_agys_own_command_and_checks_the_result(home):
    agy, record = _fake_agy(home)
    agent_clis.register_antigravity(str(agy), COMMAND)
    assert record.read_text(encoding="utf-8").split() == ["mcp", "add", "opalatex", "--", *COMMAND]
    assert agent_clis.antigravity_registration(COMMAND)["state"] == "registered"


def test_registration_failures_are_reported(home):
    agy, _ = _fake_agy(home, writes=False, exit_code=3)
    with pytest.raises(AgentCliError, match="`agy mcp add` failed"):
        agent_clis.register_antigravity(str(agy), COMMAND)
    agy, _ = _fake_agy(home, writes=False, exit_code=0)
    with pytest.raises(AgentCliError, match="does not start OpalaTex's server"):
        agent_clis.register_antigravity(str(agy), COMMAND)


def test_shell_lines_for_bash_and_powershell():
    assert agent_clis.shell_line(["/a b/claude", "--mcp-config", "/x/it's.json"], windows=False) == (
        "'/a b/claude' --mcp-config '/x/it'\"'\"'s.json'")
    assert agent_clis.shell_line([r"C:\Program Files\claude.exe", "--mcp-config", r"C:\it's.json"], windows=True) == (
        r"& 'C:\Program Files\claude.exe' '--mcp-config' 'C:\it''s.json'")


# ── The launch endpoint, with a real terminal ────────────────────────────────

def _server():
    from opalatex.ide_server import AsyncHTTPServer

    server = AsyncHTTPServer()
    responses = []
    server.send_response = lambda _w, status, body, content_type="text/plain": responses.append(
        (status, json.loads(body.decode("utf-8"))))
    return server, responses


async def _launch(server, body):
    await server.route_api("POST", "/api/external-agents/launch", {}, {}, json.dumps(body).encode(), None)


async def _wait_for_output(term, text, timeout=10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if text in term.buffer.decode("utf-8", "replace"):
            return term.buffer.decode("utf-8", "replace")
        await asyncio.sleep(0.1)
    raise AssertionError(f"{text!r} never appeared in the terminal: {term.buffer[-500:]!r}")


def test_launch_refusals(home, tmp_path, monkeypatch):
    project = tmp_path / "proj"
    project.mkdir()

    async def scenario():
        server, responses = _server()
        await _launch(server, {"agent": "nope", "projectPath": str(project), "term_id": "main-2"})
        await _launch(server, {"agent": "claude", "projectPath": str(project), "term_id": "main"})
        await _launch(server, {"agent": "claude", "projectPath": str(tmp_path / "missing"), "term_id": "main-2"})
        await _launch(server, {"agent": "claude", "projectPath": str(project), "term_id": "main-2"})
        external_access.save_config({"enabled": True})
        monkeypatch.setattr(agent_clis, "find_cli", lambda agent, search_path=None: None)
        await _launch(server, {"agent": "claude", "projectPath": str(project), "term_id": "main-2"})
        assert server.temp_terminals == {}
        return responses

    responses = asyncio.run(scenario())
    assert [(status, body["code"]) for status, body in responses] == [
        (400, "unknown_agent"), (400, "bad_terminal"), (400, "bad_project"), (409, "access_off"), (404, "not_found")]
    assert "Claude Code was not found" in responses[-1][1]["error"]


def test_launching_claude_types_its_session_command_into_a_new_tab(home, tmp_path, monkeypatch):
    project = tmp_path / "proj"
    project.mkdir()
    claude = _script(home / "bin" / "claude", 'echo "FAKE-CLAUDE $@ in $(pwd)"\n')
    monkeypatch.setattr(agent_clis, "find_cli", lambda agent, search_path=None: str(claude) if agent.id == "claude" else None)
    external_access.save_config({"enabled": True})

    async def scenario():
        server, responses = _server()
        await _launch(server, {"agent": "claude", "projectPath": str(project), "term_id": "main-2"})
        term = server.temp_terminals["main-2"]
        try:
            output = await _wait_for_output(term, "FAKE-CLAUDE --mcp-config")
        finally:
            term.close()
        return responses, output

    responses, output = asyncio.run(scenario())
    [(status, body)] = responses
    assert status == 200 and body["label"] == "Claude Code"
    config = agent_clis.claude_mcp_config_path()
    settings = agent_clis.claude_settings_path()
    assert body["command_line"] == agent_clis.shell_line(
        [str(claude), "--mcp-config", str(config), "--settings", str(settings)])
    assert f"FAKE-CLAUDE --mcp-config {config} --settings {settings} in {project}" in output
    servers = json.loads(config.read_text(encoding="utf-8"))["mcpServers"]
    assert servers["opalatex"]["args"][-1] == "mcp"
    # The session's hooks checkpoint its turns (opalatex/external_turns.py).
    hooks = json.loads(settings.read_text(encoding="utf-8"))["hooks"]
    assert hooks["Stop"][0]["hooks"][0]["command"].endswith("agent-hook turn-end --agent claude")


def test_launching_antigravity_asks_before_registering(home, tmp_path, monkeypatch):
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(external_access, "mcp_command", lambda: list(COMMAND))
    agy, record = _fake_agy(home)
    # The stand-in also answers the launch itself (no `mcp add` arguments then).
    monkeypatch.setattr(agent_clis, "find_cli", lambda agent, search_path=None: str(agy) if agent.id == "antigravity" else None)
    external_access.save_config({"enabled": True})

    async def scenario():
        server, responses = _server()
        await _launch(server, {"agent": "antigravity", "projectPath": str(project), "term_id": "main-3"})
        assert server.temp_terminals == {} and not record.exists()
        await _launch(server, {"agent": "antigravity", "projectPath": str(project), "term_id": "main-3", "register": True})
        term = server.temp_terminals["main-3"]
        term.close()
        return responses

    (first_status, first), (second_status, second) = asyncio.run(scenario())
    assert (first_status, first["code"], first["registration"]) == (409, "needs_registration", "missing")
    assert first["command_line"] == agent_clis.shell_line([str(agy), "mcp", "add", "opalatex", "--", *COMMAND])
    assert first["config_path"] == str(home / ".gemini" / "config" / "mcp_config.json")
    assert second_status == 200 and second["command_line"] == agent_clis.shell_line([str(agy)])
    assert record.read_text(encoding="utf-8").splitlines()[0].split() == ["mcp", "add", "opalatex", "--", *COMMAND]
