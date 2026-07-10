import os
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile

from .subprocess_utils import utf8_text_kwargs


PANDOC_VERSION = "3.10"


def _app_root() -> str:
    candidates = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(meipass)
        candidates.append(os.path.dirname(os.path.dirname(os.path.abspath(sys.executable))))
    candidates.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            return candidate
    return os.getcwd()


def _local_bin_dir() -> str:
    return os.path.join(_app_root(), "bin")


def _find_executable_in_dir(directory: str, executable_name: str) -> str:
    if not directory or not os.path.isdir(directory):
        return ""
    direct = os.path.join(directory, executable_name)
    if os.path.isfile(direct):
        return direct
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__"}]
        if executable_name in files:
            return os.path.join(root, executable_name)
    return ""


def get_pandoc_path() -> str | None:
    """Find pandoc in OpalaTex's bundled bin directory or in PATH."""
    exe_name = "pandoc.exe" if sys.platform == "win32" else "pandoc"
    local_exe = _find_executable_in_dir(_local_bin_dir(), exe_name)
    if local_exe:
        return local_exe
    return shutil.which("pandoc")


def get_pandoc_download() -> tuple[str, str]:
    """Return (url, filename) for the current platform."""
    base = f"https://github.com/jgm/pandoc/releases/download/{PANDOC_VERSION}"
    if sys.platform == "win32":
        name = f"pandoc-{PANDOC_VERSION}-windows-x86_64.zip"
    elif sys.platform == "darwin":
        import platform
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        name = f"pandoc-{PANDOC_VERSION}-{arch}-macOS.zip"
    else:
        name = f"pandoc-{PANDOC_VERSION}-linux-amd64.tar.gz"
    return f"{base}/{name}", name


def _safe_member_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    return os.path.basename(normalized)


def _install_executable_from_zip(archive_path: str, bin_dir: str, exe_name: str) -> str:
    with zipfile.ZipFile(archive_path, "r") as zip_ref:
        for member in zip_ref.infolist():
            if member.is_dir() or _safe_member_name(member.filename) != exe_name:
                continue
            target = os.path.join(bin_dir, exe_name)
            with zip_ref.open(member, "r") as source, open(target, "wb") as dest:
                shutil.copyfileobj(source, dest)
            return target
    raise FileNotFoundError(f"{exe_name} was not found inside {os.path.basename(archive_path)}")


def _install_executable_from_tar(archive_path: str, bin_dir: str, exe_name: str) -> str:
    with tarfile.open(archive_path, "r:gz") as tar_ref:
        for member in tar_ref.getmembers():
            if not member.isfile() or _safe_member_name(member.name) != exe_name:
                continue
            source = tar_ref.extractfile(member)
            if source is None:
                continue
            target = os.path.join(bin_dir, exe_name)
            with source, open(target, "wb") as dest:
                shutil.copyfileobj(source, dest)
            return target
    raise FileNotFoundError(f"{exe_name} was not found inside {os.path.basename(archive_path)}")


def install_pandoc_from_archive(archive_path: str, bin_dir: str | None = None) -> str:
    """Install the pandoc executable from a downloaded archive into bin/."""
    bin_dir = bin_dir or _local_bin_dir()
    os.makedirs(bin_dir, exist_ok=True)
    exe_name = "pandoc.exe" if sys.platform == "win32" else "pandoc"
    if archive_path.lower().endswith(".zip"):
        installed = _install_executable_from_zip(archive_path, bin_dir, exe_name)
    else:
        installed = _install_executable_from_tar(archive_path, bin_dir, exe_name)
    if sys.platform != "win32":
        mode = os.stat(installed).st_mode
        os.chmod(installed, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return installed


def _is_path_within(child: str, parent: str) -> bool:
    child_abs = os.path.normcase(os.path.abspath(child))
    parent_abs = os.path.normcase(os.path.abspath(parent))
    return child_abs == parent_abs or child_abs.startswith(parent_abs + os.sep)


def _resolve_project_file(project_path: str, file_path: str) -> str:
    if not project_path:
        raise ValueError("project_path is required")
    project_abs = os.path.abspath(os.path.expanduser(project_path))
    if not os.path.isdir(project_abs):
        raise ValueError("project_path is not a directory")
    full_path = os.path.abspath(file_path if os.path.isabs(file_path) else os.path.join(project_abs, file_path))
    if not _is_path_within(full_path, project_abs):
        raise ValueError("file_path must stay inside the project directory")
    return full_path


def export_tex_to_docx(project_path: str, tex_file_path: str, output_path: str = "") -> dict:
    """Convert a project .tex file to .docx using pandoc."""
    pandoc = get_pandoc_path()
    if not pandoc:
        return {
            "success": False,
            "output_path": "",
            "log": "Pandoc is not installed or not found in PATH.",
            "pandoc_found": False,
        }

    tex_abs = _resolve_project_file(project_path, tex_file_path)
    if not os.path.isfile(tex_abs):
        return {
            "success": False,
            "output_path": "",
            "log": f"TeX file not found: {tex_file_path}",
            "pandoc_found": True,
        }
    if not tex_abs.lower().endswith(".tex"):
        return {
            "success": False,
            "output_path": "",
            "log": "Only .tex files can be exported to DOCX.",
            "pandoc_found": True,
        }

    project_abs = os.path.abspath(os.path.expanduser(project_path))
    if output_path:
        out_abs = _resolve_project_file(project_abs, output_path)
    else:
        stem = os.path.splitext(os.path.basename(tex_abs))[0]
        out_abs = os.path.join(os.path.dirname(tex_abs), stem + ".docx")
    if not out_abs.lower().endswith(".docx"):
        out_abs += ".docx"
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)

    resource_paths = os.pathsep.join(dict.fromkeys([os.path.dirname(tex_abs), project_abs]))
    cmd = [
        pandoc,
        tex_abs,
        "--from=latex",
        "--to=docx",
        "--output",
        out_abs,
        "--resource-path",
        resource_paths,
    ]
    result = subprocess.run(
        cmd,
        cwd=os.path.dirname(tex_abs),
        capture_output=True,
        timeout=120,
        **utf8_text_kwargs(),
    )
    log = (result.stdout or "") + ("\n" if result.stdout and result.stderr else "") + (result.stderr or "")
    success = result.returncode == 0 and os.path.isfile(out_abs)
    if result.returncode == 0 and not os.path.isfile(out_abs):
        log = (log + "\n" if log else "") + "Pandoc finished but did not create the DOCX file."
    return {
        "success": success,
        "output_path": out_abs if success else "",
        "relative_output_path": os.path.relpath(out_abs, project_abs).replace("\\", "/") if success else "",
        "log": log,
        "pandoc_found": True,
        "returncode": result.returncode,
    }
