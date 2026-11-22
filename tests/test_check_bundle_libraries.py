"""Tests for the build gate that refuses a Linux bundle missing libraries.

The release shipped without the nine X11 client libraries Qt's xcb platform
plugin links, because the build runner did not have them and PyInstaller only
warns about a dependency it cannot find. On a stock desktop the application
then aborted with "no Qt platform plugin could be initialized". These tests hold
the gate to telling a bundled library from one that only the build machine had,
and hold the build to installing and checking them.
"""

import importlib.util
import platform
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "check_bundle_libraries", ROOT / "scripts" / "check_bundle_libraries.py"
)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

XCB_PLUGIN = "PyQt6/Qt6/plugins/platforms/libqxcb.so"
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


def _host_stack(soname):
    return soname.startswith(("libc.so", "libm.so", "libGL.so", "libxcb.so"))


def _bundle(tmp_path, *files):
    bundle = tmp_path / "OpalaTex"
    internal = bundle / "_internal"
    for relative in files:
        target = internal / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\x7fELF")
    return bundle, internal


def test_parse_ldd_reads_resolved_and_missing_libraries():
    output = (
        "\tlinux-vdso.so.1 (0x00007ffc)\n"
        "\tlibxcb-cursor.so.0 => /lib/x86_64-linux-gnu/libxcb-cursor.so.0 (0x00007d51)\n"
        "\tlibxcb-icccm.so.4 => not found\n"
        "\t/lib64/ld-linux-x86-64.so.2 (0x00007d52)\n"
    )

    assert gate.parse_ldd(output) == [
        ("libxcb-cursor.so.0", "/lib/x86_64-linux-gnu/libxcb-cursor.so.0"),
        ("libxcb-icccm.so.4", None),
    ]


def test_a_library_only_the_build_machine_has_is_refused(tmp_path):
    bundle, internal = _bundle(tmp_path, XCB_PLUGIN, "libxcb-randr.so.0")
    ldd_output = (
        f"\tlibxcb-randr.so.0 => {internal}/libxcb-randr.so.0 (0x1)\n"
        "\tlibxcb-cursor.so.0 => /lib/x86_64-linux-gnu/libxcb-cursor.so.0 (0x2)\n"
        "\tlibxcb-icccm.so.4 => not found\n"
    )

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert len(problems) == 2
    assert "libxcb-cursor.so.0" in problems[0] and XCB_PLUGIN in problems[0]
    assert "/lib/x86_64-linux-gnu/libxcb-cursor.so.0" in problems[0]
    assert "libxcb-icccm.so.4" in problems[1] and "not installed on the build machine" in problems[1]


def test_libraries_pyinstaller_leaves_to_the_host_are_allowed(tmp_path):
    """glibc, the GL driver stack and libxcb.so.1 must come from the user's system."""
    bundle, _ = _bundle(tmp_path, XCB_PLUGIN)
    ldd_output = (
        "\tlibGL.so.1 => /lib/x86_64-linux-gnu/libGL.so.1 (0x1)\n"
        "\tlibxcb.so.1 => /lib/x86_64-linux-gnu/libxcb.so.1 (0x2)\n"
        "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x3)\n"
    )

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert problems == []


def test_a_library_reached_through_a_bundled_symlink_counts_as_bundled(tmp_path):
    bundle, internal = _bundle(tmp_path, XCB_PLUGIN, "PyQt6/Qt6/lib/libQt6XcbQpa.so.6")
    (internal / "libQt6XcbQpa.so.6").symlink_to(internal / "PyQt6/Qt6/lib/libQt6XcbQpa.so.6")
    ldd_output = f"\tlibQt6XcbQpa.so.6 => {internal}/libQt6XcbQpa.so.6 (0x1)\n"

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert problems == []


def test_a_missing_startup_binary_is_reported_rather_than_skipped(tmp_path):
    """A gate that checks nothing must not pass: a moved plugin means ROOTS is stale."""
    bundle, _ = _bundle(tmp_path)

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: "", leaves_to_host=_host_stack
    )

    assert len(problems) == 1
    assert XCB_PLUGIN in problems[0] and "update ROOTS" in problems[0]


def test_the_gate_covers_the_xcb_platform_plugin():
    assert XCB_PLUGIN in gate.ROOTS


@pytest.mark.skipif(platform.system() != "Linux" or not shutil.which("ldd"), reason="needs Linux ldd")
def test_real_ldd_tells_a_bundled_copy_from_the_system_one(tmp_path):
    """Against the real loader: the same library is refused from /lib, accepted from the bundle."""
    system_lib = Path("/lib/x86_64-linux-gnu/libxcb-cursor.so.0")
    if not system_lib.exists():
        pytest.skip("libxcb-cursor0 is not installed here")
    bundle, internal = _bundle(tmp_path)
    plugin = internal / XCB_PLUGIN
    plugin.parent.mkdir(parents=True, exist_ok=True)
    # Any ELF that links libxcb-cursor stands in for the plugin.
    shutil.copy(system_lib, plugin)
    linked = subprocess.run(["ldd", str(plugin)], capture_output=True, text=True, check=True).stdout
    dependency = next(name for name, _ in gate.parse_ldd(linked) if not _host_stack(name))

    refused = gate.bundle_problems(bundle, patterns=[XCB_PLUGIN], leaves_to_host=_host_stack)
    assert any(dependency in problem for problem in refused)

    resolved = dict(gate.parse_ldd(linked))[dependency]
    shutil.copy(resolved, internal / dependency)
    remaining = gate.bundle_problems(bundle, patterns=[XCB_PLUGIN], leaves_to_host=_host_stack)
    assert not any(dependency in problem for problem in remaining)


def test_the_release_runner_installs_the_xcb_libraries_before_building():
    workflow = (ROOT / ".github" / "workflows" / "build.yml").read_text(encoding="utf-8")
    install_step = workflow.index("Install the Qt xcb libraries the Linux bundle must carry")
    build_step = workflow.index("- name: Build Linux/macOS")

    assert install_step < build_step
    step = workflow[install_step:build_step]
    for package in XCB_LIBRARIES:
        assert package in step


def test_the_linux_build_runs_the_gate_after_pyinstaller():
    script = (ROOT / "build_exe.sh").read_text(encoding="utf-8")

    assert script.index("pyinstaller --name") < script.index(
        "python scripts/check_bundle_libraries.py dist/OpalaTex"
    )


def test_parse_required_glibc_versions_reads_verneed_and_ignores_verdef():
    readelf_output = (
        "Version definition section '.gnu.version_d' contains 2 entries:\n"
        "  0x0000: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.43\n"
        "\n"
        "Version needs section '.gnu.version_r' contains 2 entries:\n"
        " Addr: 0x0000000000001000  Offset: 0x001000  Link: 6 (.dynstr)\n"
        "  000000: Version: 1  File: libc.so.6  Cnt: 3\n"
        "  0x0010:   Name: GLIBC_2.42  Flags: none  Version: 4\n"
        "  0x0020:   Name: GLIBC_2.39  Flags: none  Version: 3\n"
        "  0x0030:   Name: GLIBC_2.2.5  Flags: none  Version: 2\n"
        "  0x0040: Version: 1  File: libstdc++.so.6  Cnt: 1\n"
        "  0x0050:   Name: GLIBCXX_3.4.35  Flags: none  Version: 5\n"
    )

    assert gate.parse_required_glibc_versions(readelf_output) == {
        (2, 2, 5),
        (2, 39),
        (2, 42),
    }


def test_glibc_problems_refuses_binaries_requiring_newer_glibc(tmp_path):
    bundle, internal = _bundle(tmp_path, "libglib-2.0.so.0", "libok.so.1")
    (internal / "readme.txt").write_text("not an elf", encoding="utf-8")
    (internal / "libglib-link.so").symlink_to(internal / "libglib-2.0.so.0")

    outputs = {
        internal / "libglib-2.0.so.0": (
            "Version needs section '.gnu.version_r' contains 1 entry:\n"
            "  0x0010:   Name: GLIBC_2.43  Flags: none  Version: 3\n"
            "  0x0020:   Name: GLIBC_2.39  Flags: none  Version: 2\n"
        ),
        internal / "libok.so.1": (
            "Version needs section '.gnu.version_r' contains 1 entry:\n"
            "  0x0010:   Name: GLIBC_2.39  Flags: none  Version: 2\n"
            "  0x0020:   Name: GLIBC_2.2.5  Flags: none  Version: 1\n"
        ),
    }

    problems = gate.glibc_problems(bundle, readelf=lambda path: outputs[path])

    assert len(problems) == 1
    assert "libglib-2.0.so.0" in problems[0]
    assert "GLIBC_2.43" in problems[0]
    assert "GLIBC_2.39" in problems[0]


@pytest.mark.skipif(platform.system() != "Linux" or not shutil.which("readelf"), reason="needs Linux readelf")
def test_real_readelf_enforces_glibc_ceiling(tmp_path):
    binary = Path(shutil.which("readelf"))
    bundle, internal = _bundle(tmp_path)
    internal.mkdir(parents=True, exist_ok=True)
    target = internal / "sample-elf"
    shutil.copy(binary, target)

    # An impossibly low ceiling must reject the real host ELF; a high one accepts it.
    assert gate.glibc_problems(bundle, max_glibc=(2, 0))
    assert gate.glibc_problems(bundle, max_glibc=(2, 99)) == []


def test_the_release_runner_is_pinned_to_ubuntu_24_04():
    """Floating on ubuntu-latest moved builds onto Ubuntu 26.04 (glibc 2.43)."""
    import yaml

    workflow = yaml.safe_load(
        (ROOT / ".github" / "workflows" / "build.yml").read_text(encoding="utf-8")
    )
    build_job = workflow["jobs"]["build"]
    runners = build_job["strategy"]["matrix"]["os"]

    assert "ubuntu-24.04" in runners
    assert "ubuntu-latest" not in runners
    linux_steps = [
        step for step in build_job["steps"]
        if "ubuntu" in str(step.get("if", ""))
    ]
    assert linux_steps
    for step in linux_steps:
        assert "ubuntu-latest" not in step["if"]
