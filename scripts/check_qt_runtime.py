#!/usr/bin/env python
"""Refuse to package a Qt that is known to break OpalaTex.

The Qt a user runs is decided at build time, not at install time: install.ps1
and install.sh download the release this pipeline produces and never resolve a
Python package themselves. The floor declared in pyproject.toml therefore
protects users only if the build confirms it — `pip install .` upgrades a
too-old Qt, but nothing checked what PyInstaller was actually about to copy.

Two checks, the cheap one first:

1. The Qt floors declared in pyproject.toml (the file the build installs from)
   against the installed distributions.
2. The failure itself, on Windows: a child process imports QtWebEngine and
   *then* onnxruntime — the order the application loads them in. Qt 6.10.2
   ships MSVCP140 14.26; Windows binds a DLL name once per process, so the Qt
   copy served onnxruntime too, and the first agent message died in
   MSVCP140.dll. A version number can only stand in for that failure; this
   reproduces it. It is skipped elsewhere, where there is no MSVC runtime to
   conflict and a headless runner may lack the libraries a QtWebEngine import
   needs.

    python scripts/check_qt_runtime.py

Exit codes: 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from typing import Callable

from packaging.requirements import Requirement
from packaging.version import Version

ROOT = Path(__file__).resolve().parent.parent

QT_PACKAGES = ("pyqt6", "pyqt6-qt6", "pyqt6-webengine", "pyqt6-webengine-qt6")

# The application's own load order: the window (Qt) exists long before the first
# agent message pulls in ChromaDB's embedding function, and with it onnxruntime.
IMPORT_ORDER_PROBE = "import PyQt6.QtWebEngineWidgets\nimport onnxruntime\n"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def qt_floors(pyproject: Path = ROOT / "pyproject.toml") -> dict[str, Version]:
    """The minimum version pyproject.toml declares for each Qt package."""
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    floors: dict[str, Version] = {}
    for line in data["project"]["dependencies"]:
        req = Requirement(line)
        name = _normalize(req.name)
        if name in QT_PACKAGES:
            mins = [Version(s.version) for s in req.specifier if s.operator in (">=", "==")]
            if mins:
                floors[name] = max(mins)
    return floors


def version_problems(
    floors: dict[str, Version],
    installed: Callable[[str], str] = metadata.version,
) -> list[str]:
    problems = []
    for name in QT_PACKAGES:
        floor = floors.get(name)
        if floor is None:
            problems.append(f"pyproject.toml declares no floor for {name}")
            continue
        try:
            found = Version(installed(name))
        except metadata.PackageNotFoundError:
            problems.append(f"{name} is not installed (needs >={floor})")
            continue
        if found < floor:
            problems.append(f"{name} {found} is installed, below the declared floor {floor}")
    return problems


def import_order_problem(
    python: str = sys.executable,
    platform: str = sys.platform,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> str | None:
    """Import Qt and then onnxruntime in a child, and report how it ended."""
    if platform != "win32":
        return None
    result = runner(
        [python, "-c", IMPORT_ORDER_PROBE],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode == 0:
        return None
    code = result.returncode & 0xFFFFFFFF
    if code >= 0xC0000000:
        how = f"crashed natively (exit 0x{code:08X}), which is the C++ runtime conflict"
    else:
        how = f"failed (exit {result.returncode})"
    tail = (result.stderr or "").strip().splitlines()[-3:]
    detail = f": {' | '.join(tail)}" if tail else ""
    return (
        "importing onnxruntime after QtWebEngine " + how + detail +
        ". The application loads them in this order, so its first agent message would die the same way."
    )


def main() -> int:
    problems = version_problems(qt_floors())
    if not problems:
        order = import_order_problem()
        if order:
            problems.append(order)

    if not problems:
        installed = ", ".join(f"{name} {metadata.version(name)}" for name in QT_PACKAGES)
        print(f"Qt runtime check passed: {installed}")
        return 0

    on_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    for problem in problems:
        print(f"::error::{problem}" if on_actions else f"ERROR: {problem}", file=sys.stderr)
    print(
        "Refusing to package this Qt. See tests/test_dependency_floors.py for what "
        "broke below the floor.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
