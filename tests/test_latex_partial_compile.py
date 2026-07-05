import subprocess

from opalatex import latex_compiler


def test_partial_compile_injects_includeonly(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "\\include{chapters/one}\n"
        "\\include{chapters/two}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("old", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        preview = tmp_path / "opalatex_partial_one.tex"
        source = preview.read_text(encoding="utf-8")
        assert "\\includeonly{chapters/one}" in source
        (tmp_path / "opalatex_partial_one.pdf").write_bytes(b"%PDF")
        (tmp_path / "opalatex_partial_one.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "new content",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert result["partial"] is True
    assert result["partial_mode"] == "includeonly"
    assert chapter.read_text(encoding="utf-8") == "new content"
