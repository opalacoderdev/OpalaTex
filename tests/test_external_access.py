"""External agent access, phase 1 (docs/specs/external_agents.md).

Covers the setting (off by default), the discovery file and token, the window
command channel (`ide_control.WindowBus` / `WindowChannel`) and, end to end
against a real server on a loopback port, the stream the window keeps open and
the endpoint it answers through.
"""

import asyncio
import json
import os
import stat
import sys

import pytest

from opalatex import agent_stdin, external_access, ide_control
from opalatex.ide_control import (
    IdeCommandError,
    WindowBus,
    WindowChannel,
    resolve_ide_command,
    send_ide_command,
    use_command_channel,
)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("OPALATEX_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


# ── The setting ──────────────────────────────────────────────────────────────

def test_access_is_off_by_default(home):
    assert external_access.is_enabled() is False
    assert not external_access.config_path().exists()


def test_setting_round_trips_and_only_true_enables(home):
    assert external_access.save_config({"enabled": True}) == {"enabled": True}
    assert external_access.is_enabled() is True
    assert external_access.save_config({"enabled": "yes"}) == {"enabled": False}
    assert external_access.is_enabled() is False


def test_unreadable_setting_means_off(home):
    external_access.config_path().parent.mkdir(parents=True)
    external_access.config_path().write_text("{not json", encoding="utf-8")
    assert external_access.is_enabled() is False


# ── Discovery file and token ─────────────────────────────────────────────────

def test_publish_writes_an_owner_only_discovery_file(home):
    access = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    path = access.publish()
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record == {
        "format": external_access.INSTANCE_FORMAT,
        "pid": os.getpid(),
        "url": "http://127.0.0.1:3456",
        "token": access.token,
        "started_at": access.started_at,
    }
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert [r["token"] for r in external_access.list_instances()] == [access.token]


def test_withdraw_removes_only_this_instances_file(home):
    access = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    path = access.publish()
    access.withdraw()
    assert not path.exists()
    assert external_access.list_instances() == []

    # A newer instance on the same port replaced the file: leave it alone.
    old = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    old.publish()
    newer = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    newer.publish()
    old.withdraw()
    assert json.loads(path.read_text(encoding="utf-8"))["token"] == newer.token


def test_list_instances_skips_dead_processes_and_foreign_files(home, monkeypatch):
    access = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    access.publish()
    directory = external_access.instances_dir()
    (directory / "1.json").write_text(json.dumps({"format": "other", "pid": os.getpid()}), encoding="utf-8")
    (directory / "2.json").write_text("garbage", encoding="utf-8")
    assert len(external_access.list_instances()) == 1

    from opalatex.monitors import process
    monkeypatch.setattr(process, "pid_alive", lambda pid: False)
    assert external_access.list_instances() == []


def test_token_is_accepted_only_while_published_and_as_a_bearer(home):
    access = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    good = {"authorization": f"Bearer {access.token}"}
    assert access.authenticated(good) is False  # access off: no file, no token
    access.publish()
    assert access.authenticated(good) is True
    assert access.authenticated({"authorization": f"bearer {access.token}"}) is True
    assert access.authenticated({"authorization": f"Basic {access.token}"}) is False
    assert access.authenticated({"authorization": "Bearer wrong"}) is False
    assert access.authenticated({}) is False
    access.withdraw()
    assert access.authenticated(good) is False


def test_mcp_command_runs_this_installation(monkeypatch):
    monkeypatch.delenv("SNAP", raising=False)
    command = external_access.mcp_command()
    assert command[0] == sys.executable and command[-1] == "mcp"
    monkeypatch.setenv("SNAP", "/snap/opalatex/x1")
    monkeypatch.setenv("SNAP_INSTANCE_NAME", "opalatex")
    assert external_access.mcp_command() == ["/snap/bin/opalatex", "mcp"]


def test_running_in_snap_follows_the_snap_environment(monkeypatch):
    for name in ("SNAP", "SNAP_NAME", "SNAP_INSTANCE_NAME"):
        monkeypatch.delenv(name, raising=False)
    assert external_access.running_in_snap() is False
    monkeypatch.setenv("SNAP_NAME", "opalatex")
    assert external_access.running_in_snap() is False
    monkeypatch.setenv("SNAP", "/snap/opalatex/x1")
    assert external_access.running_in_snap() is True


def test_the_settings_say_when_opalatex_runs_as_a_snap(home, monkeypatch):
    """The window warns a snap user that external agents may not work."""
    from opalatex.ide_server import AsyncHTTPServer

    monkeypatch.setenv("SNAP", "/snap/opalatex/x1")
    monkeypatch.setenv("SNAP_NAME", "opalatex")

    async def scenario():
        server = AsyncHTTPServer(port=0)
        await server.start()
        try:
            http = _Http(server)
            _, state = await http.request("GET", "/api/settings/external-access")
            assert state["snap"] is True
            _, state = await http.request("POST", "/api/settings/external-access", {"enabled": True})
            assert state["snap"] is True and state["enabled"] is True
        finally:
            server.stop()
            server.server.close()
            await server.server.wait_closed()

    asyncio.run(scenario())


def test_the_token_is_not_the_window_session_cookie(home):
    from opalatex.local_auth import LocalSession

    session = LocalSession("127.0.0.1", 3456)
    access = external_access.ExternalAccess("http://127.0.0.1:3456", 3456)
    assert access.token != session.token


# ── The window channel ───────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def test_window_channel_delivers_to_the_window_of_the_project(tmp_path):
    async def scenario():
        bus = WindowBus()
        other = bus.connect("w-other", str(tmp_path / "other"))
        window = bus.connect("w1", str(tmp_path / "proj") + os.sep)  # trailing separator

        async def answer():
            payload = await window.queue.get()
            assert payload["event"] == "ide_command"
            assert payload["action"] == "set_layout"
            resolve_ide_command(payload["id"], {"ok": True, "layout": "chat"})

        answering = asyncio.create_task(answer())
        with use_command_channel(WindowChannel(bus)):
            result = await send_ide_command("set_layout", {"layout": "chat"}, project_path=str(tmp_path / "proj"))
        await answering
        assert result["layout"] == "chat"
        assert other.queue.empty()
        assert window.pending == set()
        assert ide_control._pending == {}

    _run(scenario())


def test_window_channel_never_uses_the_turn_stream(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(agent_stdin, "event_hook", seen.append)

    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(tmp_path))

        async def answer():
            payload = await window.queue.get()
            resolve_ide_command(payload["id"], {"ok": True})

        answering = asyncio.create_task(answer())
        with use_command_channel(WindowChannel(bus)):
            await send_ide_command("get_problems", {}, project_path=str(tmp_path))
        await answering

    _run(scenario())
    assert [e for e in seen if e.get("event") == "ide_command"] == []


def test_without_a_channel_commands_still_go_on_the_turn_stream(tmp_path, monkeypatch):
    """The built-in agent's path is unchanged by the window channel's existence."""
    seen = []

    def window(payload):
        seen.append(payload)
        if payload.get("event") == "ide_command":
            resolve_ide_command(payload["id"], {"ok": True})

    monkeypatch.setattr(agent_stdin, "event_hook", window)

    async def scenario():
        bus = WindowBus()
        listening = bus.connect("w1", str(tmp_path))
        await send_ide_command("get_problems", {}, project_path=str(tmp_path))
        assert listening.queue.empty()

    _run(scenario())
    assert [e["action"] for e in seen if e.get("event") == "ide_command"] == ["get_problems"]


def test_no_window_on_the_project_fails_at_once(tmp_path):
    async def scenario():
        bus = WindowBus()
        bus.connect("w1", str(tmp_path / "elsewhere"))
        with use_command_channel(WindowChannel(bus)):
            with pytest.raises(IdeCommandError, match="No OpalaTex window has the project"):
                await send_ide_command("get_problems", {}, project_path=str(tmp_path / "proj"), timeout=30)
        assert ide_control._pending == {}

    _run(scenario())


def test_a_window_that_disconnects_fails_its_command_at_once(tmp_path):
    async def scenario():
        bus = WindowBus()
        window = bus.connect("w1", str(tmp_path))

        async def vanish():
            await window.queue.get()
            bus.disconnect(window)

        vanishing = asyncio.create_task(vanish())
        with use_command_channel(WindowChannel(bus)):
            with pytest.raises(IdeCommandError, match="disconnected"):
                await send_ide_command("get_problems", {}, project_path=str(tmp_path), timeout=30)
        await vanishing
        assert bus.windows() == []

    _run(scenario())


def test_reconnecting_window_replaces_its_old_stream_and_latest_window_wins(tmp_path):
    async def scenario():
        bus = WindowBus()
        first = bus.connect("w1", str(tmp_path))
        second = bus.connect("w1", str(tmp_path))
        assert first.closed and await first.queue.get() is None
        assert bus.windows() == [second]
        # A stale disconnect of the replaced stream does not drop the new one.
        bus.disconnect(first)
        assert bus.windows() == [second]

        third = bus.connect("w2", str(tmp_path))
        assert bus.find(str(tmp_path)) is third

    _run(scenario())


# ── End to end: a real server, its stream and its answer endpoint ────────────

class _Http:
    def __init__(self, server):
        self.server = server
        self.host = f"127.0.0.1:{server.port}"
        self.cookie = f"{server.local_session.cookie_name}={server.local_session.token}"

    async def request(self, method, path, body=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.server.port)
        payload = json.dumps(body).encode() if body is not None else b""
        head = (
            f"{method} {path} HTTP/1.1\r\nHost: {self.host}\r\nCookie: {self.cookie}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n"
        )
        writer.write(head.encode() + payload)
        await writer.drain()
        raw = await reader.read()
        writer.close()
        status = int(raw.split(b" ", 2)[1])
        return status, json.loads(raw.split(b"\r\n\r\n", 1)[1] or b"null")

    async def open_stream(self, path):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.server.port)
        writer.write(f"GET {path} HTTP/1.1\r\nHost: {self.host}\r\nCookie: {self.cookie}\r\n\r\n".encode())
        await writer.drain()
        return reader, writer


async def _next_event(reader, name):
    """The data of the next SSE event called *name*."""
    event = None
    while True:
        line = (await asyncio.wait_for(reader.readline(), 5)).decode().rstrip("\n")
        if line.startswith("event: "):
            event = line[len("event: "):]
        elif line.startswith("data: ") and event == name:
            return json.loads(line[len("data: "):])


def test_server_end_to_end(home, tmp_path):
    from opalatex.ide_server import AsyncHTTPServer

    project = tmp_path / "proj"
    project.mkdir()

    async def scenario():
        server = AsyncHTTPServer(port=0)
        await server.start()
        http = _Http(server)
        try:
            # Off by default: no discovery file, and the window's stream is refused.
            assert await http.request("GET", "/api/settings/external-access") == (
                200, {"enabled": False, "published": False, "mcp_command": external_access.mcp_command(),
                      "snap": external_access.running_in_snap()})
            assert external_access.list_instances() == []
            status, _ = await http.request("GET", f"/api/ide/window/stream?windowId=w1&projectPath={project}")
            assert status == 409

            assert await http.request("POST", "/api/settings/external-access", {"enabled": "yes"}) == (
                400, {"error": "enabled must be true or false"})
            assert await http.request("POST", "/api/settings/external-access", {"enabled": True}) == (
                200, {"enabled": True, "published": True, "mcp_command": external_access.mcp_command(),
                      "snap": external_access.running_in_snap()})
            [instance] = external_access.list_instances()
            assert instance["url"] == f"http://127.0.0.1:{server.port}"
            assert instance["token"] == server.external_access.token

            # The window opens its stream; an external caller's command reaches it
            # and the window's answer, posted where the built-in agent's go, resolves it.
            reader, writer = await http.open_stream(
                f"/api/ide/window/stream?windowId=w1&projectPath={project}")
            await _next_event(reader, "ready")

            async def window():
                command = await _next_event(reader, "ide_command")
                assert command["action"] == "open_file"
                assert command["args"] == {"path": "main.tex"}
                await http.request("POST", "/api/opalatex/ide_command_result", {
                    "id": command["id"], "ok": True, "open_files": ["main.tex"], "current_file": "main.tex",
                })

            answering = asyncio.create_task(window())
            with use_command_channel(WindowChannel()):
                result = await send_ide_command("open_file", {"path": "main.tex"}, project_path=str(project))
            await answering
            assert result["current_file"] == "main.tex"

            # Turning the access off closes the stream and removes the file.
            assert await http.request("POST", "/api/settings/external-access", {"enabled": False}) == (
                200, {"enabled": False, "published": False, "mcp_command": external_access.mcp_command(),
                      "snap": external_access.running_in_snap()})
            assert external_access.list_instances() == []
            # The rest of the stream up to EOF: only the last event's blank separator.
            assert (await asyncio.wait_for(reader.read(), 5)).strip() == b""
            writer.close()
            assert ide_control.WINDOW_BUS.windows() == []
        finally:
            server.stop()
            server.server.close()
            await server.server.wait_closed()

    asyncio.run(scenario())


def test_server_stop_removes_the_discovery_file(home):
    from opalatex.ide_server import AsyncHTTPServer

    external_access.save_config({"enabled": True})

    async def scenario():
        server = AsyncHTTPServer(port=0)
        await server.start()
        try:
            assert len(external_access.list_instances()) == 1
        finally:
            server.stop()
            server.server.close()
            await server.server.wait_closed()
        assert external_access.list_instances() == []

    asyncio.run(scenario())
