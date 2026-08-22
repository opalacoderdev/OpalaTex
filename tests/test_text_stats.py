"""Tests for the mode-aware word/character counter used by the status bar.

The counter lives in the front-end (`gui_src/src/utils/textStats.js`), so the
tests drive it through node, the same way `test_git_review_grouping.py` does.
"""

import json
import shutil
import subprocess
import textwrap

import pytest

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed"
)

IMPORT = "import * as stats from './src/utils/textStats.js';"


def run_js(body: str):
    """Runs a snippet against textStats.js and returns its JSON output."""
    script = textwrap.dedent(f"{IMPORT}\n{textwrap.dedent(body)}")
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd="gui_src",
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def count(source: str, mode: str):
    return run_js(
        f"console.log(JSON.stringify("
        f"stats.countTextStats({json.dumps(source)}, {json.dumps(mode)})));"
    )


# ---------------------------------------------------------------------------
# Mode resolution
# ---------------------------------------------------------------------------

def test_detect_count_mode_from_extension():
    detected = run_js(
        """
        const files = [
          'main.tex', 'article.cls', 'refs.bib', 'notes.md', 'readme.MARKDOWN',
          'notes.txt', 'script.py', 'Makefile', '', null,
        ];
        console.log(JSON.stringify(files.map(f => stats.detectCountMode(f))));
        """
    )
    assert detected == [
        "latex", "latex", "latex", "markdown", "markdown",
        "text", "text", "text", "text", "text",
    ]


def test_resolve_count_mode_honors_override():
    resolved = run_js(
        """
        console.log(JSON.stringify([
          stats.resolveCountMode('main.tex', 'auto'),
          stats.resolveCountMode('main.tex', 'text'),
          stats.resolveCountMode('notes.txt', 'markdown'),
          stats.resolveCountMode('notes.txt', undefined),
          stats.resolveCountMode('notes.txt', 'bogus'),
        ]));
        """
    )
    assert resolved == ["latex", "text", "markdown", "text", "text"]


def test_next_count_mode_cycles_through_all_modes():
    cycle = run_js(
        """
        let mode = 'auto';
        const seen = [];
        for (let i = 0; i < 4; i += 1) { mode = stats.nextCountMode(mode); seen.push(mode); }
        console.log(JSON.stringify(seen));
        """
    )
    assert cycle == ["latex", "markdown", "text", "auto"]


# ---------------------------------------------------------------------------
# Plain text
# ---------------------------------------------------------------------------

def test_plain_text_counts_the_file_as_written():
    result = count("Hello brave new world.", "text")
    assert result["words"] == 4
    assert result["characters"] == 22
    assert result["rawCharacters"] == 22
    assert result["charactersNoSpaces"] == 19
    assert result["lines"] == 1


def test_empty_document_counts_zero():
    result = count("", "text")
    assert result["words"] == 0
    assert result["characters"] == 0
    assert result["rawCharacters"] == 0
    assert result["lines"] == 0


def test_punctuation_only_tokens_are_not_words():
    assert count("one --- two", "text")["words"] == 2


def test_cjk_characters_count_individually():
    # Ten ideographs/kana plus one latin word.
    assert count("日本語のテキストです。 hello", "text")["words"] == 11


def test_line_count_handles_crlf():
    assert count("a\r\nb\r\nc", "text")["lines"] == 3


# ---------------------------------------------------------------------------
# LaTeX
# ---------------------------------------------------------------------------

LATEX_DOC = textwrap.dedent(
    r"""
    \documentclass{article}
    \usepackage{amsmath}
    \title{A Preamble Title That Should Not Count}
    % a comment with several words in it
    \begin{document}
    \section{Introduction}
    This is \textbf{bold} prose~\cite{knuth1984}.
    \label{sec:intro}
    The equation $e^{i\pi} + 1 = 0$ is famous.
    \begin{equation}
      \int_0^1 x \, dx = \frac{1}{2}
    \end{equation}
    \begin{verbatim}
    this code must not be counted
    \end{verbatim}
    Around 50\% of it remains.
    \end{document}
    """
).strip()


def test_latex_counts_only_document_prose():
    result = count(LATEX_DOC, "latex")
    # Introduction / This is bold prose. / The equation is famous. /
    # Around 50% of it remains.
    assert result["words"] == 14
    assert result["rawCharacters"] == len(LATEX_DOC)
    assert result["characters"] < result["rawCharacters"]


def test_latex_extraction_drops_markup_and_keeps_prose():
    extracted = run_js(
        f"console.log(JSON.stringify("
        f"stats.extractCountableText({json.dumps(LATEX_DOC)}, 'latex')));"
    )
    assert "Introduction" in extracted
    assert "bold" in extracted
    assert "50%" in extracted          # \% is a literal character, not markup
    assert "Preamble" not in extracted  # preamble is configuration
    assert "comment" not in extracted
    assert "knuth1984" not in extracted
    assert "frac" not in extracted
    assert "this code must not be counted" not in extracted


def test_latex_command_arguments_that_are_prose_still_count():
    assert count(r"\emph{one two three}", "latex")["words"] == 3


def test_latex_long_command_names_are_not_matched_as_prefixes():
    # \reflectbox is not \ref: its argument is prose and must be counted.
    assert count(r"\reflectbox{visible word} \ref{hidden}", "latex")["words"] == 2


def test_latex_href_keeps_the_label_and_drops_the_url():
    result = run_js(
        r"""
        console.log(JSON.stringify(stats.extractCountableText(
          '\\href{https://example.com/page}{click here}', 'latex')));
        """
    )
    assert result == "click here"


def test_latex_without_begin_document_counts_the_whole_file():
    # A .sty or an included fragment has no document environment.
    assert count(r"Just a fragment with \emph{words}.", "latex")["words"] == 5


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------

MARKDOWN_DOC = textwrap.dedent(
    """
    # Title Here

    Some **bold** text with a [link label](https://example.com) and `inline_code`.

    ![alt text of an image](img.png)

    - first item
    - second item

    | Column A | Column B |
    | -------- | -------- |
    | cell one | cell two |

    ```js
    const uncounted = "code";
    ```

    Inline math $x^2 + y^2$ stays out.
    """
).strip()


def test_markdown_counts_only_rendered_prose():
    extracted = run_js(
        f"console.log(JSON.stringify("
        f"stats.extractCountableText({json.dumps(MARKDOWN_DOC)}, 'markdown')));"
    )
    assert "Title Here" in extracted
    assert "link label" in extracted   # link labels are read by the reader
    assert "cell one" in extracted
    assert "example.com" not in extracted
    assert "uncounted" not in extracted
    assert "inline_code" not in extracted
    assert "alt text of an image" not in extracted
    assert "-" not in extracted        # bullets, rules and separator rows
    assert "|" not in extracted
    assert "#" not in extracted


def test_markdown_word_count():
    result = count(MARKDOWN_DOC, "markdown")
    # Title Here / Some bold text with a link label and . / first item /
    # second item / Column A / Column B / cell one / cell two /
    # Inline math stays out.
    assert result["words"] == 26


def test_markdown_keeps_intraword_underscores():
    extracted = run_js(
        """
        console.log(JSON.stringify(
          stats.extractCountableText('a snake_case name and _emphasis_ here', 'markdown')));
        """
    )
    assert extracted == "a snake_case name and emphasis here"


def test_markdown_unterminated_code_fence_is_excluded():
    source = "Visible words here\n\n```\nnever closed fence\n"
    assert count(source, "markdown")["words"] == 3


def test_markdown_heading_markup_is_not_counted_as_a_word():
    assert count("### Deep Heading", "markdown")["words"] == 2


# ---------------------------------------------------------------------------
# Cross-mode
# ---------------------------------------------------------------------------

def test_same_source_counts_differ_per_mode():
    source = r"\section{Hello} $x+y$ world"
    latex_words = count(source, "latex")["words"]
    text_words = count(source, "text")["words"]
    assert latex_words == 2
    assert text_words > latex_words


def test_markdown_multi_backtick_code_span_is_excluded():
    extracted = run_js(
        """
        console.log(JSON.stringify(stats.extractCountableText(
          'keep ``a ` b`` and keep this', 'markdown')));
        """
    )
    assert extracted == "keep and keep this"


def test_markdown_html_and_autolinks_are_excluded():
    extracted = run_js(
        """
        console.log(JSON.stringify(stats.extractCountableText(
          '<span class="x">kept</span> <https://example.com/page> <a@b.com>',
          'markdown')));
        """
    )
    assert extracted == "kept"


def test_degenerate_markup_runs_do_not_blow_up():
    """Guards the counter against quadratic regex behaviour.

    Long runs of unmatched markup characters (a pasted separator line, a
    corrupt paste) used to make the extractor rescan the rest of the buffer
    from every position, freezing the UI for seconds. The budget is ~10x the
    healthy runtime, so it fails on a regression without being timing-flaky.
    """
    elapsed = run_js(
        """
        const cases = [
          ['`'.repeat(100000), 'markdown'],
          ['['.repeat(100000), 'markdown'],
          ['<'.repeat(100000), 'markdown'],
          ['_'.repeat(100000), 'markdown'],
          ['$'.repeat(100000), 'latex'],
          ['{'.repeat(50000) + '}'.repeat(50000), 'latex'],
        ];
        const started = performance.now();
        for (const [source, mode] of cases) stats.countTextStats(source, mode);
        console.log(JSON.stringify(performance.now() - started));
        """
    )
    assert elapsed < 3000, f"markup extraction took {elapsed:.0f}ms"


def test_well_formed_large_document_is_counted_quickly():
    elapsed = run_js(
        """
        const unit = '\\\\begin{equation}\\n x=y\\n\\\\end{equation}\\n\\nSome prose about it.\\n\\n';
        const doc = '\\\\documentclass{article}\\n\\\\begin{document}\\n'
          + unit.repeat(20000) + '\\\\end{document}';
        const started = performance.now();
        const result = stats.countTextStats(doc, 'latex');
        if (result.words !== 80000) throw new Error('unexpected words: ' + result.words);
        console.log(JSON.stringify(performance.now() - started));
        """
    )
    assert elapsed < 2000, f"1.4MB LaTeX document took {elapsed:.0f}ms"
