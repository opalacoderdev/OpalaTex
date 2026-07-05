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


def test_partial_compile_reuses_main_bibliography_artifacts(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "\\include{chapters/one}\n"
        "\\bibliography{refs}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("\\cite{doe2020}", encoding="utf-8")
    (tmp_path / "main.aux").write_text("\\bibdata{refs}\n", encoding="utf-8")
    (tmp_path / "main.bbl").write_text("\\begin{thebibliography}{1}\\bibitem{doe2020} Doe\\end{thebibliography}", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        assert (tmp_path / "opalatex_partial_one.aux").read_text(encoding="utf-8") == "\\bibdata{refs}\n"
        assert "doe2020" in (tmp_path / "opalatex_partial_one.bbl").read_text(encoding="utf-8")
        (tmp_path / "opalatex_partial_one.pdf").write_bytes(b"%PDF")
        (tmp_path / "opalatex_partial_one.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "\\cite{doe2020}",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert "opalatex_partial_one.bbl" in result["log"]


def test_partial_compile_runs_bibtex_when_no_bbl_exists(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\input{preamble/packages}\n"
        "\\begin{document}\n"
        "\\input{chapters/one}\n"
        "\\input{chapters/two}\n"
        "\\bibliography{refs}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("\\cite{doe2020}", encoding="utf-8")
    (tmp_path / "refs.bib").write_text("@article{doe2020,title={T}}\n", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")
    monkeypatch.setattr(latex_compiler.shutil, "which", lambda name: "bibtex" if name == "bibtex" else None)
    calls = []

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        calls.append(cmd[0])
        if cmd[0] == "tectonic":
            preview_source = (tmp_path / "opalatex_partial_one.tex").read_text(encoding="utf-8")
            assert "\\input{preamble/packages}" in preview_source
            assert "\\input{chapters/one}" in preview_source
            assert "skipped \\input{chapters/two}" in preview_source
            (tmp_path / "opalatex_partial_one.aux").write_text("\\bibdata{refs}\n\\citation{doe2020}\n", encoding="utf-8")
            (tmp_path / "opalatex_partial_one.pdf").write_bytes(b"%PDF")
            (tmp_path / "opalatex_partial_one.synctex.gz").write_bytes(b"synctex")
        elif cmd[0] == "bibtex":
            (tmp_path / "opalatex_partial_one.bbl").write_text("\\bibitem{doe2020} Doe", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "\\cite{doe2020}",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert calls == ["tectonic", "bibtex", "tectonic"]
