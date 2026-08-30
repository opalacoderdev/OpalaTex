"""Tests for the in-app restart used after saving restart-only settings.

The Settings modal asks the user whether to restart once OPALATEX_HOME changes;
answering yes hits ``POST /api/app/restart``, which relaunches the process.
"""

import json
import os
import pathlib
import sys
import threading
from unittest.mock import AsyncMock

import pytest

from opalatex import ide_server
from opalatex.ide_server import AsyncHTTPServer, build_relaunch_command, schedule_app_restart


def _server_with_capture():
    server = AsyncHTTPServer()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response
    return server, responses


def test_relaunch_command_runs_the_frozen_binary_directly(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "/opt/OpalaTex/OpalaTex")
    monkeypatch.setattr(sys, "argv", ["/opt/OpalaTex/OpalaTex", "--mode", "edit"])

    assert build_relaunch_command() == ["/opt/OpalaTex/OpalaTex", "--mode", "edit"]


def test_relaunch_command_reruns_the_entry_script_with_the_same_interpreter(monkeypatch, tmp_path):
    script = tmp_path / "main.py"
    script.write_text("", encoding="utf-8")
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "executable", "/usr/bin/python3")
    monkeypatch.setattr(sys, "argv", [str(script), "--model", "gpt"])

    assert build_relaunch_command() == ["/usr/bin/python3", str(script), "--model", "gpt"]


def test_relaunch_command_falls_back_to_the_cli_entry_point(monkeypatch):
    """``python -c ...`` launches leave argv[0] pointing at nothing runnable."""
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "executable", "/usr/bin/python3")
    monkeypatch.setattr(sys, "argv", ["-c"])

    assert build_relaunch_command() == [
        "/usr/bin/python3",
        "-c",
        "from opalatex.cli import main; main()",
    ]


def test_schedule_app_restart_spawns_a_replacement_then_exits(monkeypatch):
    """The child must be spawned only as this process leaves, so the port is free."""
    events = []
    finished = threading.Event()

    monkeypatch.setattr(ide_server, "build_relaunch_command", lambda: ["python", "main.py"])
    monkeypatch.setattr(
        ide_server,
        "spawn_detached",
        lambda command, cwd=None: events.append(("spawn", command, cwd)),
    )

    def fake_exit(code):
        events.append(("exit", code))
        finished.set()

    monkeypatch.setattr(os, "_exit", fake_exit)

    command = schedule_app_restart(delay=0)
    assert command == ["python", "main.py"]
    assert finished.wait(timeout=5)
    assert [e[0] for e in events] == ["spawn", "exit"]
    assert events[0][1] == ["python", "main.py"]
    assert events[1] == ("exit", 0)


def test_schedule_app_restart_keeps_running_when_the_spawn_fails(monkeypatch):
    """A failed relaunch must not leave the user with no app at all."""
    exits = []
    monkeypatch.setattr(ide_server, "build_relaunch_command", lambda: ["python", "main.py"])

    def failing_spawn(command, cwd=None):
        raise OSError("no such file")

    monkeypatch.setattr(ide_server, "spawn_detached", failing_spawn)
    monkeypatch.setattr(os, "_exit", lambda code: exits.append(code))

    schedule_app_restart(delay=0)
    for _ in range(50):
        if exits:
            break
        threading.Event().wait(0.02)
    assert exits == []


@pytest.mark.asyncio
async def test_restart_endpoint_reports_the_relaunch_command(monkeypatch):
    calls = []
    monkeypatch.setattr(
        ide_server,
        "schedule_app_restart",
        lambda: (calls.append(True), ["python", "main.py"])[1],
    )

    server, responses = _server_with_capture()
    await server.route_api("POST", "/api/app/restart", {}, {}, b"", AsyncMock())

    assert calls == [True]
    assert responses[-1][:2] == (200, {"success": True, "command": ["python", "main.py"]})


@pytest.mark.asyncio
async def test_restart_endpoint_returns_500_when_the_relaunch_cannot_be_scheduled(monkeypatch):
    def failing():
        raise RuntimeError("boom")

    monkeypatch.setattr(ide_server, "schedule_app_restart", failing)

    server, responses = _server_with_capture()
    await server.route_api("POST", "/api/app/restart", {}, {}, b"", AsyncMock())

    assert responses[-1][0] == 500
    assert responses[-1][1] == {"error": "boom"}


@pytest.mark.asyncio
async def test_saving_the_data_directory_only_requires_a_restart_when_it_changed(tmp_path, monkeypatch):
    """Re-saving the same path must not nag the user with a restart prompt."""
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: tmp_path))

    server, responses = _server_with_capture()
    writer = AsyncMock()
    target = tmp_path / "data"

    async def post(path_value):
        await server.route_api(
            "POST",
            "/api/settings/opalatexhome",
            {},
            {},
            json.dumps({"path": path_value}).encode("utf-8"),
            writer,
        )
        return responses[-1]

    assert await post(str(target)) == (200, {"success": True, "requiresRestart": True}, "application/json")
    assert (tmp_path / ".opalatexhome").read_text(encoding="utf-8") == str(target)

    assert (await post(str(target)))[1] == {"success": True, "requiresRestart": False}

    assert (await post(""))[1] == {"success": True, "requiresRestart": True}
    assert not (tmp_path / ".opalatexhome").exists()

    assert (await post(""))[1] == {"success": True, "requiresRestart": False}
