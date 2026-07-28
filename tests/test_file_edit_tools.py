from types import SimpleNamespace
import asyncio
import shutil
import subprocess

import pytest


def test_write_content_pos_inserts_before_line(tmp_path):
    from opalatex.tools import set_project_context, write_content_pos

    target = tmp_path / "main.tex"
    target.write_text("line 1\nline 3\n", encoding="utf-8")
    set_project_context(SimpleNamespace(project_path=str(tmp_path)))

    raw = getattr(write_content_pos, "_func", None) or write_content_pos
    result = asyncio.run(raw("main.tex", "line 2", 2))

    assert "Successfully inserted content at line 2" in result
    assert target.read_text(encoding="utf-8") == "line 1\nline 2\nline 3\n"


def test_replace_content_range_replaces_inclusive_lines(tmp_path):
    from opalatex.tools import replace_content_range, set_project_context

    target = tmp_path / "main.tex"
    target.write_text("a\nold 1\nold 2\nd\n", encoding="utf-8")
    set_project_context(SimpleNamespace(project_path=str(tmp_path)))

    raw = getattr(replace_content_range, "_func", None) or replace_content_range
    result = asyncio.run(raw("main.tex", 2, 3, "new 1\nnew 2"))

    assert "Successfully replaced lines 2-3" in result
    assert target.read_text(encoding="utf-8") == "a\nnew 1\nnew 2\nd\n"


def test_replace_content_range_deletes_lines_with_empty_content(tmp_path):
    from opalatex.tools import replace_content_range, set_project_context

    target = tmp_path / "main.tex"
    target.write_text("keep\nremove 1\nremove 2\nkeep too\n", encoding="utf-8")
    set_project_context(SimpleNamespace(project_path=str(tmp_path)))

    raw = getattr(replace_content_range, "_func", None) or replace_content_range
    asyncio.run(raw("main.tex", 2, 3, ""))

    assert target.read_text(encoding="utf-8") == "keep\nkeep too\n"


def test_mutating_tool_returns_blocked_result_in_plan_mode(tmp_path):
    from opalatex.tools import set_project_context, write_file

    target = tmp_path / "main.tex"
    set_project_context(SimpleNamespace(project_path=str(tmp_path), mode="plan"))

    raw = getattr(write_file, "_func", None) or write_file
    result = asyncio.run(raw("main.tex", "hello\n"))

    assert result.startswith("Execution blocked: In 'plan' mode")
    assert not target.exists()


def test_read_file_falls_back_to_cp1252(tmp_path):
    from opalatex.tools import read_file, set_project_context

    target = tmp_path / "latex_output.txt"
    target.write_bytes("Introdução\nConclusão\n".encode("cp1252"))
    set_project_context(SimpleNamespace(project_path=str(tmp_path)))

    raw = getattr(read_file, "_func", None) or read_file
    result = asyncio.run(raw("latex_output.txt"))

    assert result == "Introdução\nConclusão\n"


def test_read_content_pos_falls_back_to_cp1252(tmp_path):
    from opalatex.tools import read_content_pos, set_project_context

    target = tmp_path / "latex_output.txt"
    target.write_bytes("Linha 1\nIntrodução\nConclusão\n".encode("cp1252"))
    set_project_context(SimpleNamespace(project_path=str(tmp_path)))

    raw = getattr(read_content_pos, "_func", None) or read_content_pos
    result = asyncio.run(raw("latex_output.txt", 2, 3))

    assert result == "Introdução\nConclusão\n"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_mutating_tool_does_not_create_shadow_git_checkpoint(tmp_path):
    from opalatex.tools import set_project_context, write_file

    set_project_context(SimpleNamespace(project_path=str(tmp_path), mode="auto"))

    raw = getattr(write_file, "_func", None) or write_file
    asyncio.run(raw("main.tex", "hello\n"))

    assert (tmp_path / "main.tex").read_text(encoding="utf-8") == "hello\n"
    assert not (tmp_path / ".opalatex" / ".shadowgit").exists()


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_mutating_tool_preserves_preexisting_changes_without_checkpointing(tmp_path):
    from opalatex.tools import set_project_context, write_file

    set_project_context(SimpleNamespace(project_path=str(tmp_path), mode="auto"))
    (tmp_path / "user.tex").write_text("user edit\n", encoding="utf-8")

    raw = getattr(write_file, "_func", None) or write_file
    asyncio.run(raw("agent.tex", "agent edit\n"))

    assert (tmp_path / "user.tex").read_text(encoding="utf-8") == "user edit\n"
    assert (tmp_path / "agent.tex").read_text(encoding="utf-8") == "agent edit\n"
    assert not (tmp_path / ".opalatex" / ".shadowgit").exists()


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_agent_turn_cleanup_preserves_preexisting_uncommitted_changes(tmp_path):
    from opalatex.vcs import begin_agent_turn_checkpoint, finalize_agent_turn_checkpoint

    target = tmp_path / "user.tex"
    target.write_text("user edit\n", encoding="utf-8")

    start_checkpoint = begin_agent_turn_checkpoint(str(tmp_path))
    assert start_checkpoint
    assert finalize_agent_turn_checkpoint(str(tmp_path), start_checkpoint)

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    status = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "status",
            "--porcelain",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    assert "Agent turn start checkpoint" not in log
    assert "Agent turn end checkpoint" not in log
    assert target.read_text(encoding="utf-8") == "user edit\n"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_agent_turn_finalize_without_start_does_not_create_orphan_checkpoint(tmp_path):
    from opalatex.vcs import finalize_agent_turn_checkpoint

    target = tmp_path / "agent.tex"
    target.write_text("agent edit\n", encoding="utf-8")

    assert not finalize_agent_turn_checkpoint(str(tmp_path), None)

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )

    assert "Agent turn end checkpoint" not in log.stdout


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_labeled_agent_turn_without_changes_removes_start_and_end(tmp_path):
    from opalatex.vcs import begin_agent_turn_checkpoint, finalize_agent_turn_checkpoint

    start_checkpoint = begin_agent_turn_checkpoint(str(tmp_path), "worker:command-line")
    assert start_checkpoint
    assert finalize_agent_turn_checkpoint(str(tmp_path), start_checkpoint, "worker:command-line")

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    assert "Agent turn start checkpoint: worker:command-line" not in log
    assert "Agent turn end checkpoint: worker:command-line" not in log

