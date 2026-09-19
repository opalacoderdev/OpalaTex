"""Printing to PDF prints the document, at its own size — not the screen.

Both print paths carried the screen's magnification into the PDF: the
interface scale (`.vscode-app` zoom) plus, for the editor, the Markdown
preview's zoom and, for the chat, `.vscode-chat-history`'s own persisted zoom.
The zoom also broke pagination inside the editor's flex column: the zoomed text
printed taller than the box reserved for it, the last lines ran past the editor
area, and window chrome that the stylesheet did not hide — the resize handles,
and in the chat the composer — was drawn over them.

As in `test_chat_print_layouts.py`, this renders the real `index.css` in
QtWebEngine through the `printToPdf` call the desktop shell uses and reads the
PDF back. `test_chat_print_layouts.py` covers *which panel* each layout prints;
this one covers what the printed page looks like.
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
BLOCKS = 30
# surface -> {variant: (interface scale, the surface's own zoom)}
CASES = {
    "editor": {"plain": (1, 1), "zoomed": (1.25, 1.5)},
    "chat": {"plain": (1, 1), "zoomed": (1.25, 1.5)},
}

_RENDER_SCRIPT = textwrap.dedent(
    r"""
    import json, os, sys
    import pymupdf
    from PyQt6.QtCore import QTimer, QUrl
    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtWebEngineWidgets import QWebEngineView

    css_path, out_dir, count, cases = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4])

    def body_text(prefix):
        return "".join(
            f"<p>{prefix}{i} lorem ipsum dolor sit amet, consectetur adipiscing elit, "
            "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>"
            '<div><pre style="margin:0;padding:10px;border:1px solid #ccc">code block</pre></div>'
            for i in range(count)
        ) + f"<p>{prefix}LASTLINE</p>"

    def shell(ui_scale, printing_editor, inner):
        return (
            f'<html style="--ui-scale:{ui_scale}"><head>'
            f'<link rel="stylesheet" href="{QUrl.fromLocalFile(css_path).toString()}">'
            f'</head><body class="{"printing-editor" if printing_editor else ""}">'
            '<div id="root"><div class="vscode-app"><div class="vscode-main">'
            '<div class="vscode-activitybar">CHROME</div>'
            '<div class="vscode-sidebar" style="width:250px">CHROME</div>'
            '<div class="vscode-resizer-horizontal"></div>'
            + inner +
            '<div class="vscode-resizer-horizontal"></div>'
            '</div></div></div></body></html>'
        )

    # Mirrors App.jsx (ide layout) around EditorPanel's full Markdown preview
    # (renderRenderedPreview + FormattedMessage's zoom wrapper).
    def editor_document(ui_scale, preview_zoom):
        return shell(ui_scale, True,
            '<main class="vscode-editor-panel" style="flex:1;display:flex">'
            '<div class="vscode-editor-panel" style="position:relative">'
            '<div class="vscode-tabs">CHROME</div>'
            '<div style="flex:1;min-height:0;height:calc(100% - 35px)">'
            '<div class="vscode-editor-container" style="position:relative;height:100%">'
            '<div class="markdown-preview-container" style="padding:20px;overflow-y:auto;'
            'position:absolute;top:0;left:0;right:0;bottom:0;box-sizing:border-box">'
            f'<div style="zoom:{preview_zoom}">{body_text("DOC")}</div>'
            '</div></div></div></div>'
            '<div style="display:contents"><div class="vscode-resizer-vertical"></div>'
            '<div class="vscode-bottom-panel" style="height:250px">CHROME</div></div>'
            '</main>'
            '<aside class="vscode-chat" style="width:400px">'
            '<div class="vscode-chat-history">CHROME</div></aside>'
        )

    # Mirrors ChatPanel.jsx: header, the class-less web-search bar, the model
    # toolbar, the zoomed history, and the composer with its send button.
    def chat_document(ui_scale, chat_zoom):
        return shell(ui_scale, False,
            '<main class="vscode-editor-panel" style="flex:1;display:flex">'
            '<div class="vscode-editor-container">CHROME</div></main>'
            '<aside class="vscode-chat" style="width:400px">'
            '<div class="vscode-chat-header">CHROME</div>'
            '<div style="padding:4px 10px;border-bottom:1px solid #ccc">CHROME web search</div>'
            '<div class="vscode-chat-toolbar">CHROME</div>'
            f'<div class="vscode-chat-history" style="zoom:{chat_zoom}">'
            f'<div class="vscode-chat-msg"><div class="vscode-chat-msg-header">Agent</div>'
            f'<div class="vscode-chat-msg-content">{body_text("DOC")}</div></div></div>'
            '<form class="vscode-chat-form"><div class="vscode-chat-composer-toolbar">CHROME</div>'
            '<div class="vscode-chat-input-row"><textarea class="vscode-chat-textarea">CHROME</textarea>'
            '<button>CHROME</button></div></form></aside>'
        )

    documents = {"editor": editor_document, "chat": chat_document}

    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(1600, 900)
    jobs = [(surface, variant) for surface, variants in cases.items() for variant in variants]
    results = {}

    def render(index=0):
        if index == len(jobs):
            print(json.dumps(results))
            app.quit()
            return
        surface, variant = jobs[index]
        pdf_path = os.path.join(out_dir, f"{surface}_{variant}.pdf")

        def finished(path, success):
            view.page().pdfPrintingFinished.disconnect()
            doc = pymupdf.open(path)
            words = [
                [page.number, w[4], round(w[0], 1), round(w[3], 1)]
                for page in doc for w in page.get_text("words")
            ]
            # The resize handles, as they reach the paper: a thin bar down the
            # page against one edge (the column handles) or a thin rule across
            # its whole width (the one above the terminal). A message's own
            # accent bar is thin and tall too, which is why touching the page
            # edge is part of the test.
            def is_chrome(rect, page):
                thin_and_tall = rect.width < 8 and rect.height > page.rect.height * 0.3
                at_edge = rect.x0 <= 8 or rect.x1 >= page.rect.width - 8
                return (thin_and_tall and at_edge) or (
                    rect.width > page.rect.width * 0.9 and rect.height < 8
                )

            chrome_shapes = [
                [page.number, round(d["rect"].y0, 1)]
                for page in doc for d in page.get_drawings() if is_chrome(d["rect"], page)
            ]
            text = "".join(page.get_text() for page in doc)
            results[f"{surface}_{variant}"] = {
                "success": success,
                "words": words,
                "chrome_shapes": chrome_shapes,
                "chrome_text": text.count("CHROME"),
                "blocks": text.count("DOC"),
                "last_line": "DOCLASTLINE" in text,
            }
            QTimer.singleShot(0, lambda: render(index + 1))

        def loaded(_ok):
            view.loadFinished.disconnect()
            view.page().pdfPrintingFinished.connect(finished)
            view.page().printToPdf(pdf_path)

        view.loadFinished.connect(loaded)
        view.setHtml(documents[surface](*cases[surface][variant]), QUrl.fromLocalFile(out_dir + os.sep))

    render()
    app.exec()
    """
)

VARIANTS = [f"{surface}_{variant}" for surface, vs in CASES.items() for variant in vs]


@pytest.fixture(scope="module")
def printed(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("print_zoom")
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    proc = subprocess.run(
        [sys.executable, "-c", _RENDER_SCRIPT, str(CSS_PATH), str(out_dir),
         str(BLOCKS), json.dumps(CASES)],
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )
    json_lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    if proc.returncode != 0 or not json_lines:
        pytest.skip(f"QtWebEngine could not render offscreen: {proc.stderr[-800:]}")
    return json.loads(json_lines[-1])


@pytest.mark.parametrize("variant", VARIANTS)
def test_print_contains_the_whole_document(printed, variant):
    result = printed[variant]
    assert result["success"]
    # One mention per paragraph, plus the closing line.
    assert result["blocks"] == BLOCKS + 1
    assert result["last_line"]


@pytest.mark.parametrize("variant", VARIANTS)
def test_print_leaves_out_the_window_chrome(printed, variant):
    result = printed[variant]
    assert result["chrome_text"] == 0
    assert result["chrome_shapes"] == []


@pytest.mark.parametrize("surface", list(CASES))
def test_print_ignores_the_screen_zoom(printed, surface):
    assert printed[f"{surface}_zoomed"]["words"] == printed[f"{surface}_plain"]["words"]
