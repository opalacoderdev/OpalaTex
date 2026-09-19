"""The Markdown preview's "Print / Export PDF" must not print the screen zoom.

Printing used to carry both the interface scale (`.vscode-app` zoom) and the
preview's own zoom (FormattedMessage's root) into the PDF. The preview zoom
also broke pagination inside the editor's flex column: the zoomed text printed
taller than the box reserved for it, the last lines ran past the editor area,
and the terminal's resize handle, which the print stylesheet did not hide, was
drawn across them. As in `test_chat_print_layouts.py`, this renders the real
`index.css` in QtWebEngine through the `printToPdf` call the desktop shell uses
and reads the PDF back.
"""

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("PyQt6.QtWebEngineWidgets")
pytest.importorskip("pymupdf")

CSS_PATH = Path(__file__).resolve().parents[1] / "gui_src" / "src" / "index.css"
PARAGRAPHS = 30
# (interface scale, preview zoom)
ZOOMS = {"plain": (1, 1), "zoomed": (1.25, 1.5)}

_RENDER_SCRIPT = textwrap.dedent(
    r"""
    import json, os, sys
    import pymupdf
    from PyQt6.QtCore import QTimer, QUrl
    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtWebEngineWidgets import QWebEngineView

    css_path, out_dir, count, zooms = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4])
    body = "".join(
        f"<p>MDPARA{i} lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do "
        "eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>"
        '<div><pre style="margin:0;padding:10px;border:1px solid #ccc">code block</pre></div>'
        for i in range(count)
    ) + "<p>MDLASTLINE</p>"

    # Mirrors App.jsx (ide layout, explorer and chat open) around EditorPanel's
    # full Markdown preview (renderRenderedPreview + FormattedMessage).
    def document(ui_scale, preview_zoom):
        return (
            f'<html style="--ui-scale:{ui_scale}"><head>'
            f'<link rel="stylesheet" href="{QUrl.fromLocalFile(css_path).toString()}">'
            '</head><body class="printing-editor"><div id="root"><div class="vscode-app">'
            '<div class="vscode-main">'
            '<div class="vscode-activitybar">A</div>'
            '<div class="vscode-sidebar" style="width:250px">SIDEBAR</div>'
            '<div class="vscode-resizer-horizontal"></div>'
            '<main class="vscode-editor-panel" style="flex:1;display:flex">'
            '<div class="vscode-editor-panel" style="position:relative">'
            '<div class="vscode-tabs">TAB</div>'
            '<div style="flex:1;min-height:0;height:calc(100% - 35px)">'
            '<div class="vscode-editor-container" style="position:relative;height:100%">'
            '<div class="markdown-preview-container" style="padding:20px;overflow-y:auto;'
            'position:absolute;top:0;left:0;right:0;bottom:0;box-sizing:border-box">'
            f'<div style="zoom:{preview_zoom}">{body}</div>'
            '</div></div></div></div>'
            '<div style="display:contents"><div class="vscode-resizer-vertical"></div>'
            '<div class="vscode-bottom-panel" style="height:250px">TERMINAL</div></div>'
            '</main>'
            '<div class="vscode-resizer-horizontal"></div>'
            '<aside class="vscode-chat" style="width:400px">'
            '<div class="vscode-chat-history">CHAT</div></aside>'
            '</div></div></div></body></html>'
        )

    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(1600, 900)
    names = list(zooms)
    results = {}

    def render(index=0):
        if index == len(names):
            print(json.dumps(results))
            app.quit()
            return
        name = names[index]
        pdf_path = os.path.join(out_dir, f"{name}.pdf")

        def finished(path, success):
            view.page().pdfPrintingFinished.disconnect()
            doc = pymupdf.open(path)
            words = [
                [page.number, w[4], round(w[0], 1), round(w[3], 1)]
                for page in doc for w in page.get_text("words")
            ]
            # Filled or stroked shapes other than the code blocks' borders:
            # anything spanning most of the page width, or a thin bar spanning
            # most of its height, is window chrome (a resize handle).
            chrome = [
                [page.number, round(d["rect"].y0, 1)]
                for page in doc for d in page.get_drawings()
                if (d["rect"].width > page.rect.width * 0.9 and d["rect"].height < 8)
                or (d["rect"].width < 8 and d["rect"].height > page.rect.height * 0.3)
            ]
            text = "".join(page.get_text() for page in doc)
            results[name] = {
                "success": success,
                "words": words,
                "chrome": chrome,
                "paragraphs": text.count("MDPARA"),
                "last_line": "MDLASTLINE" in text,
                "leaked": [s for s in ("SIDEBAR", "TERMINAL", "CHAT", "TAB") if s in text],
            }
            QTimer.singleShot(0, lambda: render(index + 1))

        def loaded(_ok):
            view.loadFinished.disconnect()
            view.page().pdfPrintingFinished.connect(finished)
            view.page().printToPdf(pdf_path)

        view.loadFinished.connect(loaded)
        view.setHtml(document(*zooms[name]), QUrl.fromLocalFile(out_dir + os.sep))

    render()
    app.exec()
    """
)


@pytest.fixture(scope="module")
def printed(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("markdown_print")
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    proc = subprocess.run(
        [sys.executable, "-c", _RENDER_SCRIPT, str(CSS_PATH), str(out_dir),
         str(PARAGRAPHS), json.dumps(ZOOMS)],
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )
    json_lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    if proc.returncode != 0 or not json_lines:
        pytest.skip(f"QtWebEngine could not render offscreen: {proc.stderr[-800:]}")
    return json.loads(json_lines[-1])


@pytest.mark.parametrize("variant", list(ZOOMS))
def test_markdown_print_contains_the_whole_document_and_nothing_else(printed, variant):
    result = printed[variant]
    assert result["success"]
    assert result["paragraphs"] == PARAGRAPHS
    assert result["last_line"]
    assert result["leaked"] == []


@pytest.mark.parametrize("variant", list(ZOOMS))
def test_markdown_print_draws_no_resize_handles(printed, variant):
    assert printed[variant]["chrome"] == []


def test_markdown_print_ignores_interface_scale_and_preview_zoom(printed):
    assert printed["zoomed"]["words"] == printed["plain"]["words"]
