"""Regression tests for the direct-install uninstall contract."""

import os
import pathlib
import subprocess


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
    assert "master/uninstall.sh" in unix_installer
    assert "Windows\\CurrentVersion\\Uninstall\\OpalaTex" in windows_installer
    assert "Uninstall OpalaTex.lnk" in windows_installer
    assert "master/uninstall.ps1" in windows_installer


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
