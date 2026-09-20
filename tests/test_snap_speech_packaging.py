"""The snap has to carry espeak-ng itself, and point the library at its data.

Local voices phonemize through the system espeak-ng over ctypes, which works on
a normal desktop but not under strict confinement: the host's
``libespeak-ng.so.1`` is simply not visible, so the feature reported "espeak-ng
was not found" on every snap install. The library and its data are staged into
the snap, and because espeak-ng resolves its data directory from a path
compiled into the library (``/usr/lib/<triplet>``, which inside confinement is
the base snap and holds nothing), the launcher has to name the staged copy
through ``ESPEAK_DATA_PATH``. Both halves fail silently until someone asks for
speech, which is what these tests are here to prevent.
"""

import pathlib
import subprocess

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "snap" / "local" / "opalatex-launch"


def _stage_packages():
    snapcraft = yaml.safe_load((ROOT / "snapcraft.yaml").read_text(encoding="utf-8"))
    return snapcraft["parts"]["opalatex"]["stage-packages"]


def test_the_snap_stages_both_halves_of_espeak_ng():
    packages = _stage_packages()
    assert "libespeak-ng1" in packages
    # The library alone initializes to nothing without its phoneme tables.
    assert "espeak-ng-data" in packages


def _run_launcher(snap_root):
    """Run the real launcher with a stub interpreter that reports the env."""
    bin_dir = snap_root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    python = bin_dir / "python"
    python.write_text(
        '#!/bin/sh\necho "ESPEAK_DATA_PATH=${ESPEAK_DATA_PATH:-}"\n', encoding="utf-8"
    )
    python.chmod(0o755)

    result = subprocess.run(
        ["sh", str(LAUNCHER)],
        env={"SNAP": str(snap_root), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )
    prefix = "ESPEAK_DATA_PATH="
    line = next(l for l in result.stdout.splitlines() if l.startswith(prefix))
    return line[len(prefix):]


def test_the_launcher_points_espeak_at_the_staged_data_directory(tmp_path):
    snap_root = tmp_path / "snap"
    # Deliberately not the build host's triplet: the launcher must not hardcode one.
    data_parent = snap_root / "usr" / "lib" / "aarch64-linux-gnu"
    (data_parent / "espeak-ng-data").mkdir(parents=True)

    # ESPEAK_DATA_PATH names the parent; espeak-ng appends "espeak-ng-data".
    assert _run_launcher(snap_root) == str(data_parent)


def test_the_launcher_leaves_espeak_alone_when_nothing_is_staged(tmp_path):
    snap_root = tmp_path / "snap"
    (snap_root / "usr" / "lib").mkdir(parents=True)

    # A path invented here would override a working install rather than fix one.
    assert _run_launcher(snap_root) == ""
