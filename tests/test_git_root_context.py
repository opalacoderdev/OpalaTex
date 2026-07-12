import shutil
import subprocess
import json
from unittest.mock import AsyncMock

import pytest

from opalatex.ide_server import (
    AsyncHTTPServer,
    GitContextError,
    _discard_git_path,
    _ensure_opalatex_git_excludes,
    _is_opalatex_hidden_artifact,
    _project_path_to_repo_path,
    _repo_path_to_project_path,
    _resolve_git_context,
    get_file_tree,
)


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _init_repo(path):
    _git(path, "init")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")


@pytest.mark.asyncio
async def test_git_status_endpoint_handles_project_without_git(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    await server.route_api(
        "GET",
        "/api/git/status",
        {"projectPath": [str(project)], "shadow": ["false"]},
        {},
        b"",
        writer,
    )

    assert responses == [
        (
            200,
            {
                "files": [],
                "git_available": False,
                "error": "Selected Git root does not contain a .git repository",
            },
            "application/json",
        )
    ]


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_user_git_root_inside_project_maps_paths_to_project_relative(tmp_path):
    project = tmp_path / "project"
    inner = project / "inner"
    inner.mkdir(parents=True)
    (project / "root.txt").write_text("root", encoding="utf-8")
    (inner / "a.txt").write_text("a", encoding="utf-8")

    _init_repo(project)
    _git(project, "add", ".")
    _git(project, "commit", "-m", "root")

    _init_repo(inner)
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


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_discard_restores_staged_modified_file(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    file_path = project / "a.txt"
    file_path.write_text("original", encoding="utf-8")

    _init_repo(project)
    _git(project, "add", ".")
    _git(project, "commit", "-m", "initial")

    file_path.write_text("changed", encoding="utf-8")
    _git(project, "add", "a.txt")

    ctx = _resolve_git_context(str(project), use_shadow=False)
    _discard_git_path(ctx, "a.txt")

    assert file_path.read_text(encoding="utf-8") == "original"
    assert _git(project, "status", "--porcelain").stdout == ""


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_discard_removes_staged_new_file(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "base.txt").write_text("base", encoding="utf-8")

    _init_repo(project)
    _git(project, "add", ".")
    _git(project, "commit", "-m", "initial")

    new_file = project / "new.txt"
    new_file.write_text("new", encoding="utf-8")
    _git(project, "add", "new.txt")

    ctx = _resolve_git_context(str(project), use_shadow=False)
    _discard_git_path(ctx, "new.txt")

    assert not new_file.exists()
    assert _git(project, "status", "--porcelain").stdout == ""


def test_opalatex_partial_artifacts_are_hidden_from_file_tree(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "chapter.tex").write_text("chapter", encoding="utf-8")
    (project / "opalatex_partial_chapter.tex").write_text("generated", encoding="utf-8")
    (project / "opalatex_partial_chapter.pdf").write_text("generated", encoding="utf-8")

    tree = get_file_tree(str(project))

    paths = {item["path"].replace("\\", "/") for item in tree}
    assert "chapter.tex" in paths
    assert "opalatex_partial_chapter.tex" not in paths
    assert "opalatex_partial_chapter.pdf" not in paths
    assert _is_opalatex_hidden_artifact("nested/opalatex_partial_chapter.aux")


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_opalatex_partial_artifacts_are_excluded_from_user_git(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "main.tex").write_text("main", encoding="utf-8")

    _init_repo(project)
    _git(project, "add", ".")
    _git(project, "commit", "-m", "initial")

    ctx = _resolve_git_context(str(project), use_shadow=False)
    _ensure_opalatex_git_excludes(ctx)
    (project / "opalatex_partial_main.tex").write_text("generated", encoding="utf-8")
    (project / "opalatex_partial_main.pdf").write_text("generated", encoding="utf-8")

    assert _git(project, "status", "--porcelain").stdout == ""


def test_repo_path_to_project_path_unquotes_and_unescapes():
    ctx = {
        "project_path": "/dummy/project",
        "repo_root": "/dummy/project",
        "repo_prefix": "",
    }
    # Standard quoted path with spaces/parentheses
    assert _repo_path_to_project_path('"file (1).pdf"', ctx) == "file (1).pdf"
    # Quoted path with UTF-8 octal escape sequences
    assert _repo_path_to_project_path('"Diret\\303\\263rio/A\\303\\247\\303\\272car.pdf"', ctx) == "Diretório/Açúcar.pdf"

