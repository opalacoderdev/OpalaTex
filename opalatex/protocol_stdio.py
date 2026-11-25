"""Standard streams of a command whose stdin/stdout carry a protocol.

`opalatex mcp` speaks MCP over the stdin/stdout pipes its client (Claude Code,
Antigravity CLI) gives it. The Windows release is a windowed (GUI-subsystem)
PyInstaller build: when Python finds no valid file descriptor for a standard
stream there, it sets that stream to None, and `main.py` then replaces a
missing stdout with `os.devnull` so a `print` cannot crash the window. For the
MCP server that replacement would silence the protocol without a word.

So, for such a command only, a standard stream Python left at None is opened
again from the process's standard handle (`GetStdHandle`, which a GUI process
also receives from its parent's STARTUPINFO). A stdin or stdout that has no
handle either is not replaced: the command stops with a diagnostic instead.
stderr only carries diagnostics, so without a handle it goes to `os.devnull`.

This module imports only the standard library: `main.py` uses it before
anything else runs.
"""

from __future__ import annotations

import os
import sys

#: Win32 STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE.
_STD_HANDLE_IDS = {0: -10, 1: -11, 2: -12}
_NAMES = {0: "stdin", 1: "stdout", 2: "stderr"}


def mcp_argv(argv: list[str]) -> list[str] | None:
    """The arguments of ``opalatex mcp ...``, or None for any other command.

    As for ``monitors``, the snap launcher's ``--gui`` is skipped.
    """
    rest = [arg for arg in argv if arg != "--gui"]
    if rest and rest[0] == "mcp":
        return rest[1:]
    return None


def _windows_std_handle(fd: int):
    """The process's standard handle for *fd*, or None when it has none."""
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.restype = ctypes.c_void_p
    kernel32.GetStdHandle.argtypes = [ctypes.c_ulong]
    handle = kernel32.GetStdHandle(ctypes.c_ulong(_STD_HANDLE_IDS[fd] & 0xFFFFFFFF))
    invalid = ctypes.c_void_p(-1).value
    if not handle or handle == invalid:
        return None
    return handle


def _fd_from_windows_handle(fd: int):
    handle = _windows_std_handle(fd)
    if handle is None:
        return None
    import msvcrt

    flags = (os.O_RDONLY if fd == 0 else os.O_WRONLY) | getattr(os, "O_BINARY", 0)
    try:
        return msvcrt.open_osfhandle(handle, flags)
    except OSError:
        return None


def recover_std_stream(fd: int, *, platform: str = sys.platform, fd_from_handle=None):
    """A UTF-8 text stream on standard stream *fd* (0, 1 or 2), opened from the
    OS's standard handle, or None when the process has none.

    Only Windows has a handle beyond the file descriptor: elsewhere a stream
    Python left at None has nothing behind it.
    """
    if platform != "win32":
        return None
    new_fd = (fd_from_handle or _fd_from_windows_handle)(fd)
    if new_fd is None:
        return None
    mode = "r" if fd == 0 else "w"
    return open(new_fd, mode, encoding="utf-8", errors="replace", closefd=False)


def ensure_protocol_stdio(*, recover=recover_std_stream, sys_module=sys) -> list[str]:
    """Give every standard stream Python left at None a stream on its OS handle.

    Returns the names of protocol streams (stdin, stdout) that have none, which
    the caller must treat as fatal. A stream that already exists is kept as is.
    """
    missing = []
    for fd in (0, 1, 2):
        name = _NAMES[fd]
        if getattr(sys_module, name) is not None:
            continue
        stream = recover(fd)
        if stream is None and fd == 2:
            stream = open(os.devnull, "w", encoding="utf-8")
        if stream is None:
            missing.append(name)
            continue
        setattr(sys_module, name, stream)
    return missing


def require_protocol_stdio(command: str) -> None:
    """`ensure_protocol_stdio`, then stop with exit code 1 if stdin or stdout
    is still missing: a protocol cannot run without them."""
    missing = ensure_protocol_stdio()
    if missing:
        print(
            f"{command}: no {' and no '.join(missing)} to speak the protocol on. Start this command "
            "from an MCP client, which connects its standard input and output to pipes.",
            file=sys.stderr,
        )
        sys.exit(1)
