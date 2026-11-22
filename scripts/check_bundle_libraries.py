#!/usr/bin/env python
"""Refuse a Linux bundle that only starts on machines with extra packages.

PyInstaller copies a binary's shared-library dependencies from the machine that
runs the build. A dependency that is not installed there is reported with a
"Library not found" warning and the build carries on, so the bundle ships
without it and works only where the user happens to have it. That is how the
release came to need ``apt install libxcb-cursor0`` and friends: Qt's xcb
platform plugin links nine X11 client libraries that the GitHub runner does not
have, and on a desktop without them Qt aborts with "no Qt platform plugin could
be initialized" before the window exists.

This gate runs ``ldd`` on what the application loads to open its window — the
platform plugins, their GL integrations, QtWebEngine and Python — with the
``LD_LIBRARY_PATH`` the PyInstaller bootloader sets, and refuses every
dependency that resolves outside the bundle or not at all. The libraries
PyInstaller excludes on purpose (glibc, the GL/EGL/DRM driver stack,
``libxcb.so.1``, Wayland's client libraries) belong to the user's graphics stack
and are allowed to come from the system; the gate asks PyInstaller itself which
those are rather than keeping a copy of its list.

It also checks the ELF ``.gnu.version_r`` section of every binary in the bundle
via ``readelf -V`` against ``MAX_GLIBC_VERSION`` (2.39, Ubuntu 24.04 / Linux
Mint 22). A bundle built on a newer distro (such as Ubuntu 26.04 with glibc
2.43) passes ``ldd`` on the build host yet fails to load PyQt6 on Ubuntu 24.04
because bundled copies of ``libglib-2.0.so.0`` and ``libasound.so.2`` require
``GLIBC_2.43``.

    python scripts/check_bundle_libraries.py dist/OpalaTex

Exit codes: 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable, Iterable

# Oldest supported Linux release is Ubuntu 24.04 (and Linux Mint 22), which
# ships glibc 2.39 (PROJECT_DESIGN.md §2.3.1).
MAX_GLIBC_VERSION: tuple[int, int] = (2, 39)

# Relative to the bundle's contents directory (`_internal`). Globs, because the
# Python version is part of the library name.
ROOTS = (
    "PyQt6/Qt6/plugins/platforms/libqxcb.so",
    "PyQt6/Qt6/plugins/platforms/libqwayland.so",
    "PyQt6/Qt6/plugins/xcbglintegrations/libqxcb-glx-integration.so",
    "PyQt6/Qt6/plugins/xcbglintegrations/libqxcb-egl-integration.so",
    "PyQt6/Qt6/libexec/QtWebEngineProcess",
    "PyQt6/QtWebEngineWidgets.abi3.so",
    "libpython3*.so*",
)

_LDD_LINE = re.compile(r"^\s*(\S+)\s+=>\s+(not found|\S+)")
_GLIBC_NEED = re.compile(r"Name:\s+GLIBC_(\d+(?:\.\d+)+)\b")
_ELF_MAGIC = b"\x7fELF"


def contents_dir(bundle: Path) -> Path:
    """The directory PyInstaller puts libraries in: `_internal` since 6.0."""
    internal = bundle / "_internal"
    return internal if internal.is_dir() else bundle


def parse_ldd(output: str) -> list[tuple[str, str | None]]:
    """``(soname, resolved path or None)`` for every ``name => ...`` line.

    Lines without ``=>`` (the vDSO, the program interpreter) name nothing a
    bundle could carry and are skipped.
    """
    resolved = []
    for line in output.splitlines():
        match = _LDD_LINE.match(line)
        if not match:
            continue
        name, target = match.groups()
        resolved.append((name, None if target == "not found" else target))
    return resolved


def run_ldd(binary: Path, library_dir: Path) -> str:
    env = {**os.environ, "LD_LIBRARY_PATH": str(library_dir), "LC_ALL": "C"}
    result = subprocess.run(["ldd", str(binary)], capture_output=True, text=True, env=env, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ldd {binary} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def pyinstaller_leaves_to_host(soname: str) -> bool:
    """True for a library PyInstaller deliberately never bundles."""
    from PyInstaller.depend import dylib

    return not dylib.include_library(soname)


def _inside(path: str, root: Path) -> bool:
    real = Path(os.path.realpath(path))
    real_root = Path(os.path.realpath(root))
    return real == real_root or real_root in real.parents


def find_roots(library_dir: Path, patterns: Iterable[str] = ROOTS) -> tuple[list[Path], list[str]]:
    found, missing = [], []
    for pattern in patterns:
        matches = sorted(path for path in library_dir.glob(pattern) if path.is_file())
        if matches:
            found.extend(matches)
        else:
            missing.append(pattern)
    return found, missing


def bundle_problems(
    bundle: Path,
    *,
    patterns: Iterable[str] = ROOTS,
    ldd: Callable[[Path, Path], str] = run_ldd,
    leaves_to_host: Callable[[str], bool] = pyinstaller_leaves_to_host,
) -> list[str]:
    library_dir = contents_dir(bundle)
    roots, missing_roots = find_roots(library_dir, patterns)
    problems = [
        f"{pattern} is not in the bundle; the startup path this gate checks has moved, update ROOTS"
        for pattern in missing_roots
    ]

    reported = set()
    for root in roots:
        for soname, target in parse_ldd(ldd(root, library_dir)):
            if soname in reported or leaves_to_host(soname):
                continue
            if target is not None and _inside(target, bundle):
                continue
            reported.add(soname)
            needed_by = root.relative_to(library_dir)
            if target is None:
                problems.append(
                    f"{soname} (needed by {needed_by}) is not installed on the build machine, "
                    "so PyInstaller could not bundle it"
                )
            else:
                problems.append(
                    f"{soname} (needed by {needed_by}) was not bundled; it only resolves to the "
                    f"build machine's {target}, which users do not have by default"
                )
    return problems


def _version_key(version: tuple[int, ...]) -> tuple[int, int, int]:
    padded = list(version[:3]) + [0, 0, 0]
    return (padded[0], padded[1], padded[2])


def _format_glibc(version: tuple[int, ...]) -> str:
    return "GLIBC_" + ".".join(str(part) for part in version)


def parse_required_glibc_versions(readelf_output: str) -> set[tuple[int, ...]]:
    """Return every ``GLIBC_*`` version required in ``.gnu.version_r``.

    Only the ``Version needs section '.gnu.version_r'`` block is inspected so
    versions a library *defines* (``.gnu.version_d``) are never mistaken for
    runtime requirements.
    """
    marker = "Version needs section '.gnu.version_r'"
    start = readelf_output.find(marker)
    if start == -1:
        return set()
    section = readelf_output[start:]
    next_section = section.find("\nVersion ", len(marker))
    if next_section != -1:
        section = section[:next_section]
    return {
        tuple(int(part) for part in match.group(1).split("."))
        for match in _GLIBC_NEED.finditer(section)
    }


def run_readelf(binary: Path) -> str:
    env = {**os.environ, "LC_ALL": "C"}
    result = subprocess.run(
        ["readelf", "-V", str(binary)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"readelf -V {binary} failed: {result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout


def iter_elf_files(bundle: Path) -> list[Path]:
    """Return all regular (non-symlink) ELF files inside ``bundle``."""
    elfs = []
    for path in sorted(bundle.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with path.open("rb") as handle:
                if handle.read(4) == _ELF_MAGIC:
                    elfs.append(path)
        except OSError:
            continue
    return elfs


def glibc_problems(
    bundle: Path,
    *,
    max_glibc: tuple[int, ...] = MAX_GLIBC_VERSION,
    readelf: Callable[[Path], str] = run_readelf,
) -> list[str]:
    """Refuse any bundled ELF requiring a glibc newer than ``max_glibc``."""
    ceiling = _version_key(max_glibc)
    ceiling_label = _format_glibc(max_glibc)
    problems = []
    for elf in iter_elf_files(bundle):
        required = parse_required_glibc_versions(readelf(elf))
        too_new = sorted(
            (ver for ver in required if _version_key(ver) > ceiling),
            key=_version_key,
        )
        if too_new:
            rel = elf.relative_to(bundle)
            tags = ", ".join(_format_glibc(ver) for ver in too_new)
            problems.append(
                f"{rel} requires {tags}, above the supported ceiling {ceiling_label} "
                "(Ubuntu 24.04 / Linux Mint 22); build on ubuntu-24.04 so bundled "
                "libraries stay compatible with every supported Linux release"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: check_bundle_libraries.py <PyInstaller dist directory>", file=sys.stderr)
        return 2
    bundle = Path(args[0])
    if not bundle.is_dir():
        print(f"{bundle} is not a directory", file=sys.stderr)
        return 2

    problems = bundle_problems(bundle)
    glibc_errs = glibc_problems(bundle)
    all_problems = problems + glibc_errs
    if not all_problems:
        print(
            f"Every library the window needs is bundled or host-provided and within "
            f"{_format_glibc(MAX_GLIBC_VERSION)} ({bundle})."
        )
        return 0

    annotate = os.environ.get("GITHUB_ACTIONS") == "true"
    for problem in all_problems:
        print(f"::error::{problem}" if annotate else f"ERROR: {problem}", file=sys.stderr)
    if problems:
        print(
            "Install the package that provides each missing library on the build machine before "
            "running PyInstaller (build.yml lists them for the release runner), so it is copied "
            "into the bundle.",
            file=sys.stderr,
        )
    if glibc_errs:
        print(
            f"Build Linux releases on Ubuntu 24.04 so no bundled binary requires symbols newer "
            f"than {_format_glibc(MAX_GLIBC_VERSION)}.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
