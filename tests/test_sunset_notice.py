"""The final-version notice shown by the command-line REPL."""

import io

from rich.console import Console

from opalatex import i18n, terminal
from opalatex.successor import SUCCESSOR_NAME, SUCCESSOR_URL


def test_notice_is_translated_and_names_the_successor():
    for lang in ("en", "pt"):
        text = i18n._STRINGS[lang]["sunset_notice"].format(name=SUCCESSOR_NAME, url=SUCCESSOR_URL)
        assert SUCCESSOR_NAME in text
        assert SUCCESSOR_URL in text
    assert i18n._STRINGS["en"]["sunset_notice"] != i18n._STRINGS["pt"]["sunset_notice"]


def test_print_sunset_notice_prints_the_message_verbatim(monkeypatch):
    buffer = io.StringIO()
    monkeypatch.setattr(terminal, "console", Console(file=buffer, width=200, color_system=None))
    # Square brackets would be read as Rich markup if the message were not escaped.
    terminal.print_sunset_notice("final [version]: https://example.org")
    assert "final [version]: https://example.org" in buffer.getvalue()
