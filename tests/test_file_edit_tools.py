from types import SimpleNamespace
import asyncio


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
