"""Tests for PDF-excerpt LaTeX editing (propose with diff, apply, revert, and endpoints)."""

from __future__ import annotations

import gzip
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from opalatex.ide_server import AsyncHTTPServer
from opalatex.snippet_edit import (
    MAX_EDIT_EXCERPT_CHARS,
    MAX_EDIT_INSTRUCTION_CHARS,
    SnippetEditConflictError,
    SnippetEditError,
    SnippetEditSource,
    apply_snippet_edit,
    build_structured_diff,
    compute_text_sha256,
    execute_snippet_edit_proposal,
    replace_unique_verbatim,
    resolve_synctex_hint,
    revert_snippet_edit,
)


def _write_synctex(path, *, input_file: str, line: int = 4, page: int = 1, x: int = 100, y: int = 200):
    sp = 65536
    body = "\n".join([
        "SyncTeX Version:1",
        f"Input:1:{input_file}",
        f"{{{page}",
        f"h1,{line}:{x * sp},{y * sp}:{120 * sp},{12 * sp},0",
        f"}}{page}",
    ])
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write(body)


def _server():
    server = AsyncHTTPServer()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8"))))

    server.send_response = mock_send_response
    return server, responses


# ── Verbatim replacement & structured diff ───────────────────────────────────


def test_replace_unique_verbatim_preserves_crlf_and_reports_lines():
    content = "\\section{Intro}\r\nOld sentence here.\r\nKeep this.\r\n"
    updated, start_line, end_line = replace_unique_verbatim(
        content,
        "Old sentence here.",
        "Revised sentence here.\nWith a second line.",
    )
    assert updated == "\\section{Intro}\r\nRevised sentence here.\r\nWith a second line.\r\nKeep this.\r\n"
    assert (start_line, end_line) == (2, 2)


def test_replace_unique_verbatim_refuses_missing_ambiguous_or_identical():
    content = "alpha\nbeta\nalpha\n"
    with pytest.raises(SnippetEditError, match="not found verbatim"):
        replace_unique_verbatim(content, "gamma", "delta")
    with pytest.raises(SnippetEditError, match="matched 2 places"):
        replace_unique_verbatim(content, "alpha", "ALPHA")
    with pytest.raises(SnippetEditError, match="identical"):
        replace_unique_verbatim(content, "beta", "beta")


def test_build_structured_diff_returns_line_numbers_and_counts():
    old = "line1\nold line\nline3\n"
    new = "line1\nnew line a\nnew line b\nline3\n"
    diff_lines, added, removed, start_line, end_line = build_structured_diff(old, new)
    assert added == 2
    assert removed == 1
    assert (start_line, end_line) == (2, 2)
    kinds = [d.kind for d in diff_lines]
    assert "header" in kinds
    assert "remove" in kinds
    assert "add" in kinds


# ── SyncTeX hint resolution ──────────────────────────────────────────────────


def test_resolve_synctex_hint_uses_companion_synctex_for_standalone_pdf(tmp_path):
    tex = tmp_path / "paper.tex"
    tex.write_text(
        "\\documentclass{article}\n\\begin{document}\nIntro\nTarget sentence.\n\\end{document}\n",
        encoding="utf-8",
    )
    (tmp_path / "paper.pdf").write_bytes(b"%PDF-1.4")
    _write_synctex(tmp_path / "paper.synctex.gz", input_file="paper.tex", line=4, page=1, x=100, y=200)

    source = SnippetEditSource(
        surface="pdf",
        document_path="paper.pdf",
        source_file="paper.tex",
        page=1,
        total_pages=1,
        pdf_x=100.0,
        pdf_y=200.0,
        is_standalone_pdf=True,
    )
    hint = resolve_synctex_hint(str(tmp_path), source)
    assert hint is not None
    assert hint.rel_file == "paper.tex"
    assert hint.line == 4
    assert "Target sentence." in hint.window_text


def test_resolve_synctex_hint_refuses_generated_source(tmp_path):
    (tmp_path / "paper.pdf").write_bytes(b"%PDF-1.4")
    (tmp_path / "paper.bbl").write_text("\\bibitem{a} Ref.\n", encoding="utf-8")
    _write_synctex(tmp_path / "paper.synctex.gz", input_file="paper.bbl", line=1, page=1, x=50, y=50)

    source = SnippetEditSource(
        document_path="paper.pdf",
        page=1,
        pdf_x=50.0,
        pdf_y=50.0,
        is_standalone_pdf=True,
    )
    with pytest.raises(SnippetEditError, match="not an editable LaTeX source"):
        resolve_synctex_hint(str(tmp_path), source)


def test_resolve_synctex_hint_refuses_unnamed_generated_material(tmp_path):
    (tmp_path / "paper.pdf").write_bytes(b"%PDF-1.4")
    _write_synctex(tmp_path / "paper.synctex.gz", input_file="", line=1, page=1, x=50, y=50)

    source = SnippetEditSource(
        document_path="paper.pdf",
        page=1,
        pdf_x=50.0,
        pdf_y=50.0,
        is_standalone_pdf=True,
    )
    with pytest.raises(SnippetEditError, match="compiler-generated material"):
        resolve_synctex_hint(str(tmp_path), source)


# ── Ephemeral proposal agent ─────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("excerpt,instruction,match", [
    ("  ", "rewrite", "non-empty selection"),
    ("text", "  ", "Describe what you want"),
    ("x" * (MAX_EDIT_EXCERPT_CHARS + 1), "rewrite", "excerpt is too long"),
    ("text", "i" * (MAX_EDIT_INSTRUCTION_CHARS + 1), "description is too long"),
])
async def test_proposal_refuses_bad_input(tmp_path, excerpt, instruction, match):
    with pytest.raises(SnippetEditError, match=match):
        await execute_snippet_edit_proposal(excerpt, instruction, project_path=str(tmp_path))


@pytest.mark.asyncio
async def test_proposal_agent_retries_on_validation_error_and_leaves_disk_untouched(monkeypatch, tmp_path):
    import agenticblocks.blocks.llm.agent as agent_mod

    tex = tmp_path / "main.tex"
    original = (
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "The \\textbf{model} is fast.\n"
        "The \\textbf{model} is fast.\n"
        "Unique closing line.\n"
        "\\end{document}\n"
    )
    tex.write_text(original, encoding="utf-8")

    captured = {}

    class FakeAgent:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def run(self, agent_input):
            captured["prompt"] = agent_input.prompt
            tool_map = {t.name: t for t in captured["tools"]}
            propose = tool_map["propose_latex_edit"]

            # First attempt is ambiguous — tool rejects it cleanly.
            with pytest.raises(SnippetEditError, match="matched 2 places"):
                await propose.run(propose.input_schema()(
                    file_path="main.tex",
                    old_text="The \\textbf{model} is fast.",
                    new_text="The \\textbf{model} is accurate.",
                    summary="Update adjective",
                ))

            # Second attempt includes surrounding context to make it unique.
            ack = await propose.run(propose.input_schema()(
                file_path="main.tex",
                old_text="The \\textbf{model} is fast.\nUnique closing line.",
                new_text="The \\textbf{model} is accurate.\nUnique closing line.",
                summary="Change 'fast' to 'accurate' in the second sentence.",
            ))
            assert "Proposal validated" in ack.result
            return SimpleNamespace(final_text="Done.", budget_exhausted=False)

    monkeypatch.setattr(agent_mod, "LLMAgentBlock", FakeAgent)
    monkeypatch.setattr("opalatex.litellm_compat.wrap_agent_litellm_compat", lambda agent: agent)

    proposal = await execute_snippet_edit_proposal(
        "The model is fast.",
        "Change fast to accurate in the last occurrence",
        source=SnippetEditSource(document_path="main.pdf", source_file="main.tex", page=1),
        project_path=str(tmp_path),
        model="ollama/test-model",
    )

    assert captured["model"] == "ollama_chat/test-model"
    assert [t.name for t in captured["tools"]] == [
        "list_project_files",
        "read_project_file",
        "search_project",
        "propose_latex_edit",
    ]
    assert proposal.target_file == "main.tex"
    assert proposal.added == 1 and proposal.removed == 1
    assert proposal.base_sha256 == compute_text_sha256(original)
    # Propose phase must NEVER touch disk.
    assert tex.read_text(encoding="utf-8") == original


@pytest.mark.asyncio
async def test_proposal_refuses_escape_outside_project(monkeypatch, tmp_path):
    import agenticblocks.blocks.llm.agent as agent_mod

    outside = tmp_path.parent / "outside_secret.tex"
    outside.write_text("secret\n", encoding="utf-8")
    project = tmp_path / "proj"
    project.mkdir()
    (project / "main.tex").write_text("hello\n", encoding="utf-8")

    class FakeAgent:
        def __init__(self, **kwargs):
            self.tools = {t.name: t for t in kwargs["tools"]}

        async def run(self, _agent_input):
            propose = self.tools["propose_latex_edit"]
            with pytest.raises(SnippetEditError, match="outside the project"):
                await propose.run(propose.input_schema()(
                    file_path=str(outside),
                    old_text="secret",
                    new_text="pwned",
                ))
            return SimpleNamespace(final_text="Could not edit outside project.", budget_exhausted=False)

    monkeypatch.setattr(agent_mod, "LLMAgentBlock", FakeAgent)
    monkeypatch.setattr("opalatex.litellm_compat.wrap_agent_litellm_compat", lambda agent: agent)

    with pytest.raises(SnippetEditError, match="Could not edit outside project"):
        await execute_snippet_edit_proposal("secret", "change it", project_path=str(project))
    assert outside.read_text(encoding="utf-8") == "secret\n"


# ── Apply & Revert ───────────────────────────────────────────────────────────


def test_apply_and_revert_enforce_sha256_and_keep_synctex_enabled(monkeypatch, tmp_path):
    tex = tmp_path / "main.tex"
    original = "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n"
    tex.write_text(original, encoding="utf-8")
    base_sha = compute_text_sha256(original)

    compile_calls = []

    def fake_compile(tex_content, file_path, main_file, project_dir, include_pdf_base64=True, draft=False, synctex=None):
        compile_calls.append({"draft": draft, "synctex": synctex, "main_file": main_file, "content": tex_content})
        return {
            "success": True,
            "pdf_path": str(tmp_path / "main.pdf"),
            "synctex_path": str(tmp_path / "main.synctex.gz"),
            "log": "ok",
        }

    monkeypatch.setattr("opalatex.latex_compiler.compile_latex", fake_compile)

    # Stale SHA is rejected with a conflict error and leaves disk untouched.
    with pytest.raises(SnippetEditConflictError, match="changed on disk"):
        apply_snippet_edit(str(tmp_path), "main.tex", "Hello world.", "Hi world.", "badsha")
    assert tex.read_text(encoding="utf-8") == original

    # Valid apply writes disk and compiles with synctex=True, draft=False.
    applied = apply_snippet_edit(str(tmp_path), "main.tex", "Hello world.", "Hi world.", base_sha)
    assert applied.compile_success is True
    assert "Hi world." in tex.read_text(encoding="utf-8")
    assert compile_calls[-1]["synctex"] is True
    assert compile_calls[-1]["draft"] is False

    # Revert with wrong SHA is refused.
    with pytest.raises(SnippetEditConflictError, match="modified since"):
        revert_snippet_edit(str(tmp_path), "main.tex", "wrongsha", original)

    # Valid revert restores original text and recompiles.
    reverted = revert_snippet_edit(str(tmp_path), "main.tex", applied.new_sha256, applied.previous_content)
    assert reverted.compile_success is True
    assert tex.read_text(encoding="utf-8") == original


def test_apply_refuses_non_utf8_files_without_touching_disk(monkeypatch, tmp_path):
    """A Latin-1 file must never be decoded with replacement characters and rewritten."""
    compile_calls = []
    monkeypatch.setattr(
        "opalatex.latex_compiler.compile_latex",
        lambda *a, **k: compile_calls.append(a) or {"success": True, "log": ""},
    )

    # Non-UTF-8 target: refused at validation, bytes unchanged.
    latin_bytes = "Ol\u00e1 mundo.\n".encode("latin-1")
    target = tmp_path / "latin.tex"
    target.write_bytes(latin_bytes)
    with pytest.raises(SnippetEditError, match="not valid UTF-8"):
        apply_snippet_edit(str(tmp_path), "latin.tex", "mundo", "world", "anysha")
    assert target.read_bytes() == latin_bytes

    # UTF-8 chapter whose compile root is Latin-1: compile_latex would save the
    # root back, so the edit is refused before the chapter is written.
    root_bytes = (
        "\\documentclass{article}\n\\begin{document}\n% Se\u00e7\u00e3o\n"
        "\\input{chapter}\n\\end{document}\n"
    ).encode("latin-1")
    (tmp_path / "main.tex").write_bytes(root_bytes)
    chapter = tmp_path / "chapter.tex"
    chapter_text = "Hello world.\n"
    chapter.write_text(chapter_text, encoding="utf-8")
    with pytest.raises(SnippetEditError, match="not valid UTF-8"):
        apply_snippet_edit(
            str(tmp_path),
            "chapter.tex",
            "Hello world.",
            "Hi world.",
            compute_text_sha256(chapter_text),
            main_file="main.tex",
        )
    assert chapter.read_text(encoding="utf-8") == chapter_text
    assert (tmp_path / "main.tex").read_bytes() == root_bytes
    assert compile_calls == []


# ── HTTP API endpoints & exclusive lock membership ───────────────────────────


def test_exclusive_work_paths_include_apply_and_revert_but_not_propose():
    assert "/api/latex/excerpt-edit/apply" in AsyncHTTPServer.EXCLUSIVE_WORK_PATHS
    assert "/api/latex/excerpt-edit/revert" in AsyncHTTPServer.EXCLUSIVE_WORK_PATHS
    assert "/api/latex/excerpt-edit/propose" not in AsyncHTTPServer.EXCLUSIVE_WORK_PATHS


@pytest.mark.asyncio
async def test_api_apply_and_revert_endpoints(monkeypatch, tmp_path):
    tex = tmp_path / "doc.tex"
    original = "\\documentclass{article}\n\\begin{document}\nOld text.\n\\end{document}\n"
    tex.write_text(original, encoding="utf-8")
    (tmp_path / "doc.pdf").write_bytes(b"%PDF-1.4")

    def fake_compile(_content, _file_path, _main_file, _project_dir, **_kwargs):
        return {
            "success": True,
            "pdf_path": str(tmp_path / "doc.pdf"),
            "synctex_path": str(tmp_path / "doc.synctex.gz"),
            "log": "",
        }

    monkeypatch.setattr("opalatex.latex_compiler.compile_latex", fake_compile)

    server, responses = _server()
    base_sha = compute_text_sha256(original)

    # Apply via standalone PDF path
    await server.route_api(
        "POST",
        "/api/latex/excerpt-edit/apply",
        {},
        {},
        json.dumps({
            "projectPath": str(tmp_path),
            "targetFile": "doc.tex",
            "oldText": "Old text.",
            "newText": "New text.",
            "baseSha256": base_sha,
            "pdfPath": "doc.pdf",
        }).encode("utf-8"),
        AsyncMock(),
    )
    status, body = responses[-1]
    assert status == 200
    assert body["compileSuccess"] is True
    assert body["compiledMainFile"] == "doc.tex"
    assert "New text." in tex.read_text(encoding="utf-8")

    # Applying again with the old SHA returns HTTP 409
    await server.route_api(
        "POST",
        "/api/latex/excerpt-edit/apply",
        {},
        {},
        json.dumps({
            "projectPath": str(tmp_path),
            "targetFile": "doc.tex",
            "oldText": "Old text.",
            "newText": "Another text.",
            "baseSha256": base_sha,
            "pdfPath": "doc.pdf",
        }).encode("utf-8"),
        AsyncMock(),
    )
    assert responses[-1][0] == 409

    # Revert via endpoint
    await server.route_api(
        "POST",
        "/api/latex/excerpt-edit/revert",
        {},
        {},
        json.dumps({
            "projectPath": str(tmp_path),
            "targetFile": "doc.tex",
            "expectedSha256": body["newSha256"],
            "previousContent": body["previousContent"],
            "pdfPath": "doc.pdf",
        }).encode("utf-8"),
        AsyncMock(),
    )
    rev_status, rev_body = responses[-1]
    assert rev_status == 200
    assert rev_body["compileSuccess"] is True
    assert tex.read_text(encoding="utf-8") == original
