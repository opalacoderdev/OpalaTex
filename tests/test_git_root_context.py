import shutil
import subprocess

import pytest

from opalatex.ide_server import (
    GitContextError,
    _project_path_to_repo_path,
    _repo_path_to_project_path,
    _resolve_git_context,
)


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_user_git_root_inside_project_maps_paths_to_project_relative(tmp_path):
    project = tmp_path / "project"
    inner = project / "inner"
    inner.mkdir(parents=True)
    (project / "root.txt").write_text("root", encoding="utf-8")
    (inner / "a.txt").write_text("a", encoding="utf-8")

    _git(project, "init")
    _git(project, "config", "user.email", "test@example.com")
    _git(project, "config", "user.name", "Test")
    _git(project, "add", ".")
    _git(project, "commit", "-m", "root")

    _git(inner, "init")
    _git(inner, "config", "user.email", "test@example.com")
    _git(inner, "config", "user.name", "Test")
    _git(inner, "add", ".")
    _git(inner, "commit", "-m", "inner")

    ctx = _resolve_git_context(str(project), use_shadow=False, git_root_path=str(inner))

    assert _repo_path_to_project_path("a.txt", ctx) == "inner/a.txt"
    assert _project_path_to_repo_path("inner/a.txt", ctx) == "a.txt"

    (inner / "a.txt").write_text("changed", encoding="utf-8")
    status = subprocess.run(
        ctx["git_cmd"] + ["status", "--porcelain"],
        cwd=ctx["cwd"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    repo_path = status.splitlines()[0][3:].strip()
    assert repo_path == "a.txt"
    assert _repo_path_to_project_path(repo_path, ctx) == "inner/a.txt"


def test_user_git_root_must_stay_inside_project(tmp_path):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()

    with pytest.raises(GitContextError):
        _resolve_git_context(str(project), use_shadow=False, git_root_path=str(outside))
