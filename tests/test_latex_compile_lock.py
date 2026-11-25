"""One Tectonic run at a time per project (latex_compiler.project_compile_lock).

The Compile button, the built-in agent's compile_latex, an external agent's and
an excerpt edit all write the PDF, SyncTeX and aux files next to the main file;
two runs on one project overwrote each other's outputs. A fake Tectonic records
when each run starts and ends, so the test sees whether runs overlapped.
"""

import os
import stat
import sys
import textwrap
import threading

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="fake Tectonic is a POSIX script")

RUN_SECONDS = 0.4


@pytest.fixture
def fake_tectonic(tmp_path, monkeypatch):
    from opalatex import latex_compiler

    record = tmp_path / "runs.log"
    script = tmp_path / "tectonic"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import os, sys, time
        with open({str(record)!r}, "a") as f:
            f.write(f"start {{os.getcwd()}} {{time.monotonic()}}\\n")
        time.sleep({RUN_SECONDS})
        with open({str(record)!r}, "a") as f:
            f.write(f"end {{os.getcwd()}} {{time.monotonic()}}\\n")
        sys.exit(1)
    """), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: str(script))
    return record


def _project(root, name):
    path = root / name
    path.mkdir()
    (path / "main.tex").write_text("\\documentclass{article}\\begin{document}x\\end{document}\n", encoding="utf-8")
    return str(path)


def _intervals(record):
    starts, intervals = {}, []
    for line in record.read_text().splitlines():
        kind, cwd, at = line.split(" ")
        if kind == "start":
            starts.setdefault(cwd, []).append(float(at))
        else:
            intervals.append((starts[cwd].pop(0), float(at)))
    return sorted(intervals)


def _compile_concurrently(*project_dirs):
    from opalatex.latex_compiler import compile_latex

    threads = [
        threading.Thread(target=compile_latex, args=("",), kwargs={
            "main_file": "main.tex", "project_dir": project_dir, "include_pdf_base64": False, "draft": True,
        })
        for project_dir in project_dirs
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)


def test_compiles_of_one_project_do_not_overlap(tmp_path, fake_tectonic):
    project = _project(tmp_path, "paper")

    _compile_concurrently(project, project)

    (first_start, first_end), (second_start, _second_end) = _intervals(fake_tectonic)
    assert second_start >= first_end


def test_compiles_of_different_projects_run_side_by_side(tmp_path, fake_tectonic):
    _compile_concurrently(_project(tmp_path, "one"), _project(tmp_path, "two"))

    (_first_start, first_end), (second_start, _second_end) = _intervals(fake_tectonic)
    assert second_start < first_end


def test_a_partial_compile_of_the_main_file_reenters_the_lock(tmp_path, fake_tectonic):
    from opalatex.latex_compiler import compile_latex_partial

    project = _project(tmp_path, "paper")
    main = os.path.join(project, "main.tex")
    done = []
    thread = threading.Thread(target=lambda: done.append(compile_latex_partial(
        open(main, encoding="utf-8").read(), main, "main.tex", project, include_pdf_base64=False, draft=True,
    )))
    thread.start()
    thread.join(30)

    assert done and done[0]["partial_mode"] == "main"
    assert len(_intervals(fake_tectonic)) == 1
