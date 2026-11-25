"""Standard streams of `opalatex mcp` (opalatex/protocol_stdio.py).

A windowed build may start with stdin/stdout set to None, and `main.py`
replaces a missing stdout with devnull, which would silence the MCP protocol.
For `opalatex mcp` the streams are reopened from the OS's standard handles
instead, or the command stops with a diagnostic.
"""

import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

from opalatex.protocol_stdio import ensure_protocol_stdio, mcp_argv, recover_std_stream

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_mcp_argv_recognises_the_command_and_skips_the_snap_flag():
    assert mcp_argv(["mcp"]) == []
    assert mcp_argv(["--gui", "mcp", "--project", "/p"]) == ["--project", "/p"]
    assert mcp_argv(["--gui"]) is None
    assert mcp_argv(["monitors", "mcp"]) is None


def test_existing_streams_are_kept():
    streams = SimpleNamespace(stdin=object(), stdout=object(), stderr=object())
    before = dict(vars(streams))

    assert ensure_protocol_stdio(recover=lambda fd: pytest.fail("nothing to recover"), sys_module=streams) == []
    assert vars(streams) == before


def test_missing_streams_are_reopened_from_their_handles():
    opened = {fd: SimpleNamespace(fd=fd) for fd in (0, 1, 2)}
    streams = SimpleNamespace(stdin=None, stdout=None, stderr=None)

    assert ensure_protocol_stdio(recover=opened.get, sys_module=streams) == []
    assert (streams.stdin, streams.stdout, streams.stderr) == (opened[0], opened[1], opened[2])


def test_a_protocol_stream_without_a_handle_is_reported_not_replaced():
    streams = SimpleNamespace(stdin=None, stdout=None, stderr=None)

    assert ensure_protocol_stdio(recover=lambda fd: None, sys_module=streams) == ["stdin", "stdout"]
    assert streams.stdin is None and streams.stdout is None
    # stderr carries only diagnostics: devnull is enough for it.
    assert streams.stderr.name == os.devnull
    streams.stderr.close()


def test_on_windows_a_stream_is_opened_on_the_handle_descriptor():
    read_fd, write_fd = os.pipe()
    try:
        out = recover_std_stream(1, platform="win32", fd_from_handle=lambda fd: write_fd)
        out.write("ação\n")
        out.flush()
        assert os.read(read_fd, 100).decode("utf-8") == "ação\n"
        assert recover_std_stream(0, platform="win32", fd_from_handle=lambda fd: None) is None
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_elsewhere_a_missing_stream_has_nothing_behind_it():
    assert recover_std_stream(1, platform="linux", fd_from_handle=lambda fd: pytest.fail("no handles")) is None


@pytest.mark.skipif(sys.platform == "win32", reason="closes a descriptor before exec")
def test_opalatex_mcp_without_stdout_stops_with_a_diagnostic(tmp_path):
    """Before the fix, `main.py` gave it devnull and it served into the void."""
    env = dict(os.environ, OPALATEX_HOME=str(tmp_path))
    result = subprocess.run(
        [sys.executable, os.path.join(_REPO_ROOT, "main.py"), "mcp"],
        stdin=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        preexec_fn=lambda: os.close(1),
        cwd=str(tmp_path),
        env=env,
        timeout=60,
    )

    assert result.returncode == 1
    assert b"opalatex mcp: no stdout to speak the protocol on" in result.stderr
