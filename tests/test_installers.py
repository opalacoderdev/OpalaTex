"""Regression tests for the direct-install uninstall contract."""

import os
import pathlib
import platform
import subprocess
import tarfile

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_unix_uninstaller_removes_owned_files_and_preserves_user_data(tmp_path):
    home = tmp_path / "home"
    install_dir = home / ".local" / "share" / "OpalaTex"
    bin_dir = home / ".local" / "bin"
    applications = home / ".local" / "share" / "applications"
    data_dir = home / ".opalatex"
    install_dir.mkdir(parents=True)
    bin_dir.mkdir(parents=True)
    applications.mkdir(parents=True)
    data_dir.mkdir()
    (install_dir / "OpalaTex").write_text("binary", encoding="utf-8")
    (install_dir / "uninstall.sh").write_text("script", encoding="utf-8")
    (data_dir / "sessions.db").write_text("chats", encoding="utf-8")
    (bin_dir / "opalatex").symlink_to(install_dir / "OpalaTex")
    (bin_dir / "opalatex-uninstall").symlink_to(install_dir / "uninstall.sh")
    (applications / "opalatex.desktop").write_text(
        f"[Desktop Entry]\nExec={install_dir}/OpalaTex\n", encoding="utf-8"
    )
    bashrc = home / ".bashrc"
    bashrc.write_text(
        f"export BEFORE=1\n\n# OpalaTex PATH\nexport PATH=\"{bin_dir}:$PATH\"\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(ROOT / "uninstall.sh")],
        env={**os.environ, "HOME": str(home), "PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not install_dir.exists()
    assert not (bin_dir / "opalatex").exists()
    assert not (applications / "opalatex.desktop").exists()
    assert "OpalaTex PATH" not in bashrc.read_text(encoding="utf-8")
    assert (data_dir / "sessions.db").read_text(encoding="utf-8") == "chats"


def test_installers_publish_discoverable_uninstall_entry_points():
    unix_installer = (ROOT / "install.sh").read_text(encoding="utf-8")
    windows_installer = (ROOT / "install.ps1").read_text(encoding="utf-8")

    assert '"$BIN_DIR/opalatex-uninstall"' in unix_installer
    assert "Windows\\CurrentVersion\\Uninstall\\OpalaTex" in windows_installer
    assert "Uninstall OpalaTex.lnk" in windows_installer


def test_uninstaller_fallback_fetch_is_branch_independent():
    """A literal branch in the raw URL 404s the moment the release branch moves.

    `uninstall.sh` does not exist on `master`, so the hardcoded ref made the
    fallback download fail on every real install. `HEAD` lets GitHub resolve the
    repository's default branch instead.
    """
    unix_installer = (ROOT / "install.sh").read_text(encoding="utf-8")
    windows_installer = (ROOT / "install.ps1").read_text(encoding="utf-8")

    assert 'UNINSTALLER_REF="HEAD"' in unix_installer
    assert '$UNINSTALLER_REF/uninstall.sh' in unix_installer
    assert '$uninstallerRef = "HEAD"' in windows_installer
    assert '$uninstallerRef/uninstall.ps1' in windows_installer

    for installer in (unix_installer, windows_installer):
        assert "master/uninstall" not in installer


def test_a_missing_uninstaller_does_not_abort_the_installation():
    """The payload is already unpacked when the uninstaller is fetched.

    Aborting there leaves a half-installed application behind over a convenience
    script, so the failure warns and continues, and the `opalatex-uninstall`
    entry point is only published when the script is actually present.
    """
    unix_installer = (ROOT / "install.sh").read_text(encoding="utf-8")
    windows_installer = (ROOT / "install.ps1").read_text(encoding="utf-8")

    uninstaller_fetch = unix_installer.split("predates the bundled uninstaller", 1)[1]
    guarded_block = uninstaller_fetch.split("Creating command symlink", 1)[0]
    assert "exit 1" not in guarded_block
    assert "continuing without it" in guarded_block
    # The symlink and the success hint are both conditional on the real file.
    assert 'if [[ -n "$UNINSTALLER_PATH" ]]; then' in unix_installer

    assert "$hasUninstaller = Test-Path $uninstallerPath" in windows_installer
    assert "if ($hasUninstaller) {" in windows_installer
    assert "continuing without it" in windows_installer


def _run_unix_installer_on_package(tmp_path, payload):
    """Install a fake release tarball whose files are `payload` (path -> text)."""
    package = tmp_path / "package" / "OpalaTex"
    for relative, content in payload.items():
        target = package / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    archive = tmp_path / "OpalaTex-linux-x64.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(package, arcname=".")

    home = tmp_path / "home"
    home.mkdir()
    bin_dir = home / ".local" / "bin"
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh")],
        env={
            **os.environ,
            "HOME": str(home),
            "OPALATEX_DOWNLOAD_URL": archive.as_uri(),
            # Already on PATH, so the installer leaves shell rc files alone.
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    return home, result


@pytest.mark.skipif(platform.system() != "Linux", reason="install.sh selects the Linux asset only on Linux")
def test_unix_installer_resolves_pyinstaller6_internal_resources(tmp_path):
    """PyInstaller 6+ bundles data files under `_internal/`.

    The launcher entry pointed at `<install>/icon.png`, which that layout never
    creates, so the app showed up with a blank icon; the bundled uninstaller was
    likewise missed and `opalatex-uninstall` was never published.
    """
    home, result = _run_unix_installer_on_package(
        tmp_path,
        {
            "OpalaTex": "binary",
            "_internal/icon.png": "png",
            "_internal/uninstall.sh": "#!/usr/bin/env bash\n",
        },
    )

    assert result.returncode == 0, result.stderr
    install_dir = home / ".local" / "share" / "OpalaTex"
    desktop = (home / ".local" / "share" / "applications" / "opalatex.desktop").read_text(encoding="utf-8")
    assert f"Icon={install_dir}/_internal/icon.png\n" in desktop
    uninstall_link = home / ".local" / "bin" / "opalatex-uninstall"
    assert os.readlink(uninstall_link) == f"{install_dir}/_internal/uninstall.sh"

    removal = subprocess.run(
        ["bash", str(ROOT / "uninstall.sh")],
        env={**os.environ, "HOME": str(home), "PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )
    assert removal.returncode == 0, removal.stderr
    assert not os.path.lexists(uninstall_link)
    assert not install_dir.exists()


@pytest.mark.skipif(platform.system() != "Linux", reason="install.sh selects the Linux asset only on Linux")
def test_unix_installer_keeps_legacy_flat_layout_resources(tmp_path):
    home, result = _run_unix_installer_on_package(
        tmp_path,
        {"OpalaTex": "binary", "icon.png": "png", "uninstall.sh": "#!/usr/bin/env bash\n"},
    )

    assert result.returncode == 0, result.stderr
    install_dir = home / ".local" / "share" / "OpalaTex"
    desktop = (home / ".local" / "share" / "applications" / "opalatex.desktop").read_text(encoding="utf-8")
    assert f"Icon={install_dir}/icon.png\n" in desktop
    assert os.readlink(home / ".local" / "bin" / "opalatex-uninstall") == f"{install_dir}/uninstall.sh"


def test_windows_installers_resolve_pyinstaller6_internal_uninstaller():
    """PyInstaller 6+ bundles `uninstall.ps1` under `_internal\\`.

    Looking only beside the executable missed it, so the installer fell back to
    a network download; the uninstaller must also recognise the Start-menu
    shortcut that now points into `_internal\\`.
    """
    installer = (ROOT / "install.ps1").read_text(encoding="utf-8")
    uninstaller = (ROOT / "uninstall.ps1").read_text(encoding="utf-8")

    assert '"$exeDir\\_internal\\uninstall.ps1"' in installer
    assert '"$exeDir\\uninstall.ps1"' in installer
    assert '(Join-Path $installDir "_internal\\uninstall.ps1")' in uninstaller
    assert '(Join-Path $installDir "OpalaTex\\_internal\\uninstall.ps1")' in uninstaller


def test_unix_uninstaller_rejects_relative_purge_before_removing_app(tmp_path):
    home = tmp_path / "home"
    install_dir = home / ".local" / "share" / "OpalaTex"
    install_dir.mkdir(parents=True)
    (install_dir / "OpalaTex").write_text("binary", encoding="utf-8")

    result = subprocess.run(
        ["bash", str(ROOT / "uninstall.sh"), "--purge", "--yes"],
        env={
            **os.environ,
            "HOME": str(home),
            "OPALATEX_HOME": "relative-data",
            "PATH": os.environ.get("PATH", ""),
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "relative data directory" in result.stderr
    assert (install_dir / "OpalaTex").exists()


def test_windows_uninstaller_requires_explicit_purge_and_exact_path_entries():
    uninstaller = (ROOT / "uninstall.ps1").read_text(encoding="utf-8")

    assert "[switch]$Purge" in uninstaller
    assert "[switch]$Yes" in uninstaller
    assert "OrdinalIgnoreCase" in uninstaller
    assert '"PathAdded"' in uninstaller
    assert "Project directories were preserved" in uninstaller
