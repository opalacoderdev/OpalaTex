"""Tests for the Linux Mint 21 (.deb) packaging script and manual workflow."""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parent.parent
BUILD_DEB = ROOT / "scripts" / "build_deb.sh"
DEB_WORKFLOW = ROOT / ".github" / "workflows" / "deb.yml"

XCB_LIBRARIES = (
    "libxcb-cursor0",
    "libxcb-icccm4",
    "libxcb-image0",
    "libxcb-keysyms1",
    "libxcb-render-util0",
    "libxcb-shape0",
    "libxcb-util1",
    "libxcb-xkb1",
    "libxkbcommon-x11-0",
)


def _make_fake_bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "OpalaTex"
    internal = bundle / "_internal"
    internal.mkdir(parents=True)
    exe = bundle / "OpalaTex"
    exe.write_text("#!/bin/sh\necho OpalaTex\n", encoding="utf-8")
    exe.chmod(0o755)
    (internal / "uninstall.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (internal / "data.txt").write_text("payload", encoding="utf-8")
    return bundle


@pytest.mark.skipif(
    platform.system() != "Linux" or not shutil.which("dpkg-deb"),
    reason="requires Linux with dpkg-deb",
)
def test_build_deb_produces_valid_package_layout(tmp_path):
    bundle = _make_fake_bundle(tmp_path)
    out_dir = tmp_path / "out"

    result = subprocess.run(
        [
            "bash",
            str(BUILD_DEB),
            "--bundle-dir",
            str(bundle),
            "--output-dir",
            str(out_dir),
            "--version",
            "0.2.45",
            "--max-glibc",
            "2.35",
        ],
        env={**os.environ, "PYTHON_BIN": sys.executable},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    deb_path = out_dir / "opalatex_0.2.45_amd64.deb"
    assert deb_path.is_file()

    info = subprocess.run(
        ["dpkg-deb", "--field", str(deb_path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "Package: opalatex" in info
    assert "Version: 0.2.45" in info
    assert "Architecture: amd64" in info
    assert "libc6 (>= 2.35)" in info
    assert "libasound2 | libasound2t64" in info
    assert "espeak-ng" in info

    contents = subprocess.run(
        ["dpkg-deb", "--contents", str(deb_path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "./opt/opalatex/OpalaTex" in contents
    assert "./usr/bin/opalatex -> /opt/opalatex/OpalaTex" in contents
    assert "./usr/share/applications/opalatex.desktop" in contents
    assert "./usr/share/pixmaps/opalatex.png" in contents
    assert "uninstall.sh" not in contents

    extracted = tmp_path / "extracted"
    subprocess.run(["dpkg-deb", "-R", str(deb_path), str(extracted)], check=True)
    desktop = (extracted / "usr" / "share" / "applications" / "opalatex.desktop").read_text(
        encoding="utf-8"
    )
    assert "Exec=/usr/bin/opalatex" in desktop
    assert "Icon=opalatex" in desktop
    assert os.access(extracted / "DEBIAN" / "postinst", os.X_OK)
    assert os.access(extracted / "DEBIAN" / "postrm", os.X_OK)


@pytest.mark.skipif(
    platform.system() != "Linux" or not shutil.which("dpkg-deb") or not shutil.which("readelf"),
    reason="requires Linux with dpkg-deb and readelf",
)
def test_build_deb_rejects_elf_above_glibc_ceiling(tmp_path):
    bundle = _make_fake_bundle(tmp_path)
    sample_elf = Path(shutil.which("readelf"))
    shutil.copy(sample_elf, bundle / "_internal" / "sample-elf")
    out_dir = tmp_path / "out"

    result = subprocess.run(
        [
            "bash",
            str(BUILD_DEB),
            "--bundle-dir",
            str(bundle),
            "--output-dir",
            str(out_dir),
            "--version",
            "0.2.45",
            "--max-glibc",
            "2.0",
        ],
        env={**os.environ, "PYTHON_BIN": sys.executable},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "GLIBC_2.0" in result.stderr
    assert not list(out_dir.glob("*.deb"))


def test_deb_workflow_is_manual_only_and_targets_ubuntu_22_04():
    raw = DEB_WORKFLOW.read_text(encoding="utf-8")
    workflow = yaml.safe_load(raw)

    # PyYAML parses the `on` key as boolean True under YAML 1.1.
    triggers = workflow.get("on") or workflow.get(True)
    assert list(triggers.keys()) == ["workflow_dispatch"]
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert inputs["attach_to_release"]["default"] is False
    assert "tag" in inputs

    build_job = workflow["jobs"]["build-deb"]
    assert build_job["runs-on"] == "ubuntu-24.04"
    assert build_job["container"]["image"] == "ubuntu:22.04"

    test_job = workflow["jobs"]["test-deb"]
    assert test_job["runs-on"] == "ubuntu-24.04"
    assert test_job["container"]["image"] == "ubuntu:22.04"
    assert test_job["needs"] == "build-deb"

    publish_job = workflow["jobs"]["publish-deb"]
    assert "attach_to_release" in str(publish_job["if"])
    assert "gh release view" in raw
    assert "gh release upload" in raw

    for package in XCB_LIBRARIES:
        assert package in raw
    assert "--max-glibc 2.35" in raw
