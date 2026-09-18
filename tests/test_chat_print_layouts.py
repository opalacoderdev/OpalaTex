"""Chat "Export as PDF / Print" must print the chat in every layout.

The chat-bottom and studio layouts mount the chat *inside*
`.vscode-editor-panel`, and the print stylesheet used to hide that panel
outright when printing the chat, so the exported PDF was a single blank page.
A string check on the stylesheet cannot catch that interaction, so this test
renders the real `index.css` in QtWebEngine and goes through the same
`printToPdf` call the desktop shell uses, then reads the PDF back.
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
MESSAGE_COUNT = 40

_RENDER_SCRIPT = textwrap.dedent(
    r"""
    import json, os, sys
    import pymupdf
    from PyQt6.QtCore import QTimer, QUrl
    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtWebEngineWidgets import QWebEngineView

    css_path, out_dir, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
    messages = "".join(
        '<div class="vscode-chat-msg"><div class="vscode-chat-msg-header">Agent</div>'
        f'<div class="vscode-chat-msg-content">CHATMSG {i}</div></div>'
        for i in range(count)
    )

    def chat(style):
        return (
            f'<aside class="vscode-chat" style="{style}">'
            '<div class="vscode-chat-header">header</div>'
            f'<div class="vscode-chat-history">{messages}</div></aside>'
        )

    editor = '<div class="editor-area">EDITORTEXT</div>'
    terminal = '<div class="vscode-studio-terminal-cell" style="display:flex">EDITORTEXT</div>'
    # Mirrors App.jsx: where ChatPanel is mounted relative to the editor panel.
    layouts = {
        "ide": f'<main class="vscode-editor-panel" style="flex:1;display:flex">{editor}</main>'
               + chat("width:400px"),
        "chat": '<main class="vscode-editor-panel" style="flex:0;display:none">'
                f'{editor}</main>' + chat("flex:1;width:100%"),
        "chat-bottom": '<main class="vscode-editor-panel vscode-chat-bottom-layout" '
                       f'style="flex:1;display:flex">{editor}{chat("flex:1;width:100%")}'
                       f'{terminal}</main>',
        "studio": '<main class="vscode-editor-panel vscode-studio-layout" '
                  f'style="flex:1;display:grid">{editor}{chat("flex:1;width:100%")}'
                  f'{terminal}</main>',
    }

    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(1200, 800)
    names = list(layouts)
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
            text = "".join(page.get_text() for page in doc)
            results[name] = {
                "success": success,
                "messages": text.count("CHATMSG"),
                "editor_leaked": "EDITORTEXT" in text,
            }
            QTimer.singleShot(0, lambda: render(index + 1))

        def loaded(_ok):
            view.loadFinished.disconnect()
            view.page().pdfPrintingFinished.connect(finished)
            view.page().printToPdf(pdf_path)

        view.loadFinished.connect(loaded)
        view.setHtml(
            f'<html><head><link rel="stylesheet" href="{QUrl.fromLocalFile(css_path).toString()}">'
            '</head><body><div id="root"><div class="vscode-app"><div class="vscode-main">'
            f'{layouts[name]}</div></div></div></body></html>',
            QUrl.fromLocalFile(out_dir + os.sep),
        )

    render()
    app.exec()
    """
)


@pytest.fixture(scope="module")
def printed_layouts(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("chat_print")
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    proc = subprocess.run(
        [sys.executable, "-c", _RENDER_SCRIPT, str(CSS_PATH), str(out_dir), str(MESSAGE_COUNT)],
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )
    json_lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    if proc.returncode != 0 or not json_lines:
        pytest.skip(f"QtWebEngine could not render offscreen: {proc.stderr[-800:]}")
    return json.loads(json_lines[-1])


@pytest.mark.parametrize("layout", ["ide", "chat", "chat-bottom", "studio"])
def test_chat_print_contains_every_message(printed_layouts, layout):
    result = printed_layouts[layout]
    assert result["success"]
    assert result["messages"] == MESSAGE_COUNT


@pytest.mark.parametrize("layout", ["ide", "chat", "chat-bottom", "studio"])
def test_chat_print_leaves_out_the_editor_and_terminal(printed_layouts, layout):
    assert not printed_layouts[layout]["editor_leaked"]
