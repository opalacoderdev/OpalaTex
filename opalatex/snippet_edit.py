"""Targeted LaTeX edits initiated from a PDF excerpt ("Edit excerpt…").

The user selects a passage in a PDF associated with LaTeX (either the compiled
preview of a ``.tex`` tab or a standalone ``.pdf`` whose sibling ``.tex``
compiles it), describes the desired change, reviews the proposed diff, and
confirms before anything is written or recompiled.

This is deliberately a two-phase flow and **not** a chat turn:

1. **Propose (read-only)**: ``execute_snippet_edit_proposal`` resolves a
   SyncTeX hint when available, then runs an ephemeral ``LLMAgentBlock`` with
   read-only project access (reusing ``ProjectReader`` from
   ``opalatex.snippet_query``) plus a single in-memory validation tool
   (``propose_latex_edit``). No file on disk is modified during proposal.
2. **Apply / Revert**: ``apply_snippet_edit`` verifies that the target file
   still matches ``base_sha256`` (refusing stale writes with a conflict),
   applies the exact unique replacement while preserving line endings, and
   recompiles with ``synctex=True`` so subsequent PDF edits stay anchored.
   ``revert_snippet_edit`` restores the previous snapshot under the same
   optimistic concurrency check.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any

from opalatex.snippet_query import ProjectReader
from opalatex.text_diff import line_diff

MAX_EDIT_EXCERPT_CHARS = 20000
MAX_EDIT_INSTRUCTION_CHARS = 4000

# Same rationale as snippet_query and prompt evolution: a focused excerpt edit
# should not inherit full research-depth reasoning budgets, and "low" keeps
# Ollama reasoning isolated from the content channel.
SNIPPET_EDIT_REASONING_EFFORT = "low"

SNIPPET_EDIT_MAX_TOOL_CALLS = 14
SNIPPET_EDIT_MAX_ITERATIONS = 18

# SyncTeX records lines where TeX shipped a box (often the end of a paragraph
# or `\end{frame}`), so the window reaches further backwards than forwards.
SYNCTEX_WINDOW_LINES_BEFORE = 45
SYNCTEX_WINDOW_LINES_AFTER = 25

EDITABLE_LATEX_EXTS = frozenset({
    ".tex",
    ".ltx",
    ".bib",
    ".sty",
    ".cls",
    ".def",
    ".dtx",
    ".ins",
})


class SnippetEditError(ValueError):
    """Domain error for a refused or invalid PDF-excerpt LaTeX edit."""


class SnippetEditConflictError(SnippetEditError):
    """The target LaTeX file changed on disk since the proposal was built."""


@dataclass
class SnippetEditSource:
    """Where the excerpt was selected in the PDF viewer."""

    surface: str = "pdf"
    document_path: str = ""
    source_file: str = ""
    page: int | None = None
    total_pages: int | None = None
    pdf_x: float | None = None
    pdf_y: float | None = None
    is_standalone_pdf: bool = False

    @classmethod
    def from_payload(cls, data: Any) -> "SnippetEditSource":
        if not isinstance(data, dict):
            return cls()

        def _pos_int(value: Any) -> int | None:
            try:
                number = int(value)
            except (TypeError, ValueError):
                return None
            return number if number > 0 else None

        def _opt_float(value: Any) -> float | None:
            if value is None or value == "":
                return None
            try:
                number = float(value)
            except (TypeError, ValueError):
                return None
            return number if number == number else None  # reject NaN

        return cls(
            surface=str(data.get("surface") or "pdf").strip() or "pdf",
            document_path=str(data.get("documentPath") or "").strip(),
            source_file=str(data.get("sourceFile") or "").strip(),
            page=_pos_int(data.get("page")),
            total_pages=_pos_int(data.get("totalPages")),
            pdf_x=_opt_float(data.get("pdfX")),
            pdf_y=_opt_float(data.get("pdfY")),
            is_standalone_pdf=bool(data.get("isStandalonePdf", False)),
        )


@dataclass
class SynctexHint:
    """Approximate LaTeX source location derived from SyncTeX coordinates."""

    rel_file: str
    line: int
    window_start: int
    window_end: int
    window_text: str


@dataclass
class DiffLine:
    """One display line of a unified diff for the confirmation card."""

    kind: str  # "header" | "context" | "remove" | "add"
    text: str
    old_line: int | None = None
    new_line: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "text": self.text,
            "oldLine": self.old_line,
            "newLine": self.new_line,
        }


@dataclass
class SnippetEditProposal:
    """Validated, unapplied edit ready for user confirmation."""

    target_file: str
    old_text: str
    new_text: str
    summary: str
    base_sha256: str
    start_line: int
    end_line: int
    added: int
    removed: int
    diff_lines: list[DiffLine] = field(default_factory=list)
    files_read: list[str] = field(default_factory=list)
    synctex_file: str = ""
    synctex_line: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "targetFile": self.target_file,
            "oldText": self.old_text,
            "newText": self.new_text,
            "summary": self.summary,
            "baseSha256": self.base_sha256,
            "startLine": self.start_line,
            "endLine": self.end_line,
            "added": self.added,
            "removed": self.removed,
            "diffLines": [line.to_dict() for line in self.diff_lines],
            "filesRead": list(self.files_read),
            "synctexFile": self.synctex_file,
            "synctexLine": self.synctex_line,
        }


@dataclass
class SnippetEditApplyResult:
    """Outcome of writing a confirmed (or reverted) LaTeX edit and compiling."""

    target_file: str
    compiled_main_file: str
    compile_success: bool
    compile_log: str
    new_content: str
    previous_content: str
    new_sha256: str
    start_line: int
    end_line: int
    pdf_path: str = ""
    synctex_path: str = ""


def compute_text_sha256(text: str) -> str:
    """Stable content hash used for optimistic concurrency between propose and apply."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _normalize_eol(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _detect_eol(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def _ensure_editable_latex_path(reader: ProjectReader, file_path: str) -> tuple[str, str]:
    """Resolve *file_path* inside the project and check that it is an editable LaTeX source."""
    raw = str(file_path or "").strip()
    if not raw:
        raise SnippetEditError("file_path is required.")
    try:
        real = reader.resolve(raw)
    except ValueError as exc:
        raise SnippetEditError(str(exc)) from exc
    if not os.path.isfile(real):
        raise SnippetEditError(f"'{reader.rel(real)}' does not exist in the project.")
    ext = os.path.splitext(real)[1].lower()
    if ext not in EDITABLE_LATEX_EXTS:
        raise SnippetEditError(
            f"'{reader.rel(real)}' is not an editable LaTeX source file "
            f"(supported: {', '.join(sorted(EDITABLE_LATEX_EXTS))})."
        )
    return real, reader.rel(real)


def _read_raw_source(real_path: str, rel_name: str, *, lenient: bool = False) -> str:
    """Read a LaTeX source verbatim (no newline translation).

    Strict by default: every caller that may write the text back (validation,
    apply, revert, and the compile root that ``compile_latex`` saves before
    compiling) needs the exact file contents, and decoding a non-UTF-8 file
    with replacement characters would silently corrupt it on write. Only the
    read-only SyncTeX context window passes ``lenient=True``.
    """
    try:
        with open(real_path, "r", encoding="utf-8", errors="replace" if lenient else "strict", newline="") as handle:
            return handle.read()
    except UnicodeDecodeError as exc:
        raise SnippetEditError(
            f"'{rel_name}' is not valid UTF-8 text, so it cannot be edited safely from the PDF "
            "(rewriting it would corrupt its characters). Convert the file to UTF-8 first."
        ) from exc
    except OSError as exc:
        raise SnippetEditError(f"Could not read '{rel_name}': {exc}") from exc


def replace_unique_verbatim(content: str, old_text: str, new_text: str) -> tuple[str, int, int]:
    """Replace *old_text* with *new_text* in *content*, requiring an exact unique match.

    Matches on LF-normalized text so CRLF files never fail on line-ending
    mismatches, then writes the result using *content*'s original line endings.
    Returns ``(updated_content, start_line, end_line)`` where line numbers are
    1-based in the original file.
    """
    if not old_text:
        raise SnippetEditError("old_text must not be empty.")
    eol = _detect_eol(content)
    norm_content = _normalize_eol(content)
    norm_old = _normalize_eol(old_text)
    norm_new = _normalize_eol(new_text)

    if norm_old == norm_new:
        raise SnippetEditError("new_text is identical to old_text; no change was proposed.")

    count = norm_content.count(norm_old)
    if count == 0:
        raise SnippetEditError(
            "old_text was not found verbatim in the file. Read the exact source lines "
            "and copy old_text verbatim without line numbers or extra formatting."
        )
    if count > 1:
        raise SnippetEditError(
            f"old_text matched {count} places in the file. Include more surrounding lines "
            "in old_text so it uniquely identifies the passage."
        )

    index = norm_content.index(norm_old)
    start_line = norm_content.count("\n", 0, index) + 1
    end_line = start_line + norm_old.count("\n")

    updated_norm = norm_content[:index] + norm_new + norm_content[index + len(norm_old):]
    updated = updated_norm.replace("\n", eol) if eol != "\n" else updated_norm
    return updated, start_line, end_line


def build_structured_diff(old_content: str, new_content: str, context: int = 3) -> tuple[list[DiffLine], int, int, int, int]:
    """Compute structured diff lines plus summary line stats."""
    old_lines = _normalize_eol(old_content).splitlines()
    new_lines = _normalize_eol(new_content).splitlines()
    result = line_diff(old_lines, new_lines, a_first=1, b_first=1, context=context)

    if result.identical:
        return [], 0, 0, 1, 1

    start_line = result.blocks[0][0]
    end_line = max(result.blocks[-1][1], start_line)

    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    diff_lines: list[DiffLine] = []
    for group in matcher.get_grouped_opcodes(max(0, context)):
        changed = [op for op in group if op[0] != "equal"]
        a_start = changed[0][1] + 1
        a_end = changed[-1][2]
        b_start = changed[0][3] + 1
        b_end = changed[-1][4]
        old_span = f"{a_start}" if a_end <= a_start else f"{a_start}-{a_end}"
        new_span = f"{b_start}" if b_end <= b_start else f"{b_start}-{b_end}"
        diff_lines.append(DiffLine(kind="header", text=f"@@ -{old_span} +{new_span} @@"))
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for offset in range(i2 - i1):
                    diff_lines.append(
                        DiffLine(
                            kind="context",
                            old_line=i1 + offset + 1,
                            new_line=j1 + offset + 1,
                            text=old_lines[i1 + offset],
                        )
                    )
                continue
            for idx in range(i1, i2):
                diff_lines.append(DiffLine(kind="remove", old_line=idx + 1, new_line=None, text=old_lines[idx]))
            for idx in range(j1, j2):
                diff_lines.append(DiffLine(kind="add", old_line=None, new_line=idx + 1, text=new_lines[idx]))

    return diff_lines, result.added, result.removed, start_line, end_line


def _resolve_synctex_file(
    project_path: str,
    source: SnippetEditSource,
    *,
    main_file: str = "",
    last_synctex_path: str = "",
) -> str:
    """Locate the SyncTeX file corresponding to the PDF currently on screen."""
    from opalatex.latex_compiler import determine_main_file_for_compilation
    from opalatex.synctex_parser import companion_synctex_path

    if source.is_standalone_pdf and source.document_path:
        pdf_full = os.path.abspath(os.path.join(project_path, source.document_path))
        return companion_synctex_path(pdf_full)

    if last_synctex_path and os.path.isfile(last_synctex_path):
        return last_synctex_path

    candidate_tex = source.source_file or main_file
    if candidate_tex:
        full_tex = os.path.abspath(os.path.join(project_path, candidate_tex))
        content = ""
        try:
            with open(full_tex, "r", encoding="utf-8", errors="ignore") as handle:
                content = handle.read()
        except OSError:
            pass
        resolved_main = determine_main_file_for_compilation(full_tex, content, project_path, main_file)
        if resolved_main:
            main_abs = os.path.abspath(os.path.join(project_path, resolved_main))
            candidate = os.path.splitext(main_abs)[0] + ".synctex.gz"
            if os.path.isfile(candidate):
                return candidate

    if source.document_path:
        pdf_full = os.path.abspath(os.path.join(project_path, source.document_path))
        return companion_synctex_path(pdf_full)
    return ""


def resolve_synctex_hint(
    project_path: str,
    source: SnippetEditSource,
    *,
    main_file: str = "",
    last_synctex_path: str = "",
) -> SynctexHint | None:
    """Resolve an approximate ``(file, line)`` and verbatim window via SyncTeX.

    Raises ``SnippetEditError`` if SyncTeX proves the excerpt came from
    compiler-generated material that has no editable source file. Returns
    ``None`` when SyncTeX data or click coordinates are unavailable.
    """
    from opalatex.synctex_parser import GeneratedSourceError, find_source_line

    if source.page is None or source.pdf_x is None or source.pdf_y is None:
        return None

    synctex_path = _resolve_synctex_file(
        project_path,
        source,
        main_file=main_file,
        last_synctex_path=last_synctex_path,
    )
    if not synctex_path:
        return None

    try:
        hit = find_source_line(synctex_path, source.page, source.pdf_x, source.pdf_y)
    except GeneratedSourceError as exc:
        raise SnippetEditError(
            "The selected passage comes from compiler-generated material (such as a table of "
            "contents, bibliography output, or auxiliary file) rather than an editable LaTeX "
            f"source file: {exc}"
        ) from exc

    if not hit or not hit.get("file"):
        return None

    abs_file = hit["file"]
    if not os.path.isabs(abs_file):
        base_dir = os.path.dirname(synctex_path) if source.is_standalone_pdf else project_path
        abs_file = os.path.abspath(os.path.join(base_dir, abs_file))
    if not os.path.isfile(abs_file):
        return None

    reader = ProjectReader(project_path)
    try:
        real = reader.resolve(abs_file)
    except ValueError:
        return None

    ext = os.path.splitext(real)[1].lower()
    if ext not in EDITABLE_LATEX_EXTS:
        # Generated LaTeX outputs like .toc / .bbl / .aux live inside the project
        # but must not be edited directly.
        raise SnippetEditError(
            f"The selected passage maps to '{reader.rel(real)}', which is not an editable "
            "LaTeX source file."
        )

    rel_file = reader.rel(real)
    line_no = max(1, int(hit.get("line") or 1))
    raw = _normalize_eol(_read_raw_source(real, rel_file, lenient=True))
    lines = raw.split("\n")
    start_idx = max(0, line_no - 1 - SYNCTEX_WINDOW_LINES_BEFORE)
    end_idx = min(len(lines), line_no + SYNCTEX_WINDOW_LINES_AFTER)
    window_text = "\n".join(lines[start_idx:end_idx])
    return SynctexHint(
        rel_file=rel_file,
        line=line_no,
        window_start=start_idx + 1,
        window_end=end_idx,
        window_text=window_text,
    )


def build_snippet_edit_system_prompt() -> str:
    return "\n\n".join([
        "You prepare a surgical, reviewable LaTeX edit for a passage the user selected "
        "in a rendered PDF. Nothing is written to disk until the user approves the diff.",
        "The selected excerpt comes from the PDF text layer, so LaTeX commands (\\textbf, "
        "\\emph, \\cite, \\ref, custom macros, math environments), line breaks, ligatures "
        "and hyphenation differ from the raw .tex source. Locate the exact corresponding "
        "LaTeX source before proposing an edit.",
        "Tools available:\n"
        "- list_project_files, read_project_file, search_project: read-only access to the project.\n"
        "- propose_latex_edit(file_path, old_text, new_text, summary): validates and records "
        "the proposed replacement without modifying disk.",
        "Rules:\n"
        "1. Always call propose_latex_edit once you find the exact source. If propose_latex_edit "
        "reports that old_text did not match or matched multiple places, read the exact lines "
        "and call propose_latex_edit again with verbatim text.\n"
        "2. Keep the edit strictly scoped to what the user requested. Preserve surrounding "
        "LaTeX structure, labels, citations, macros, formatting, and language unless the "
        "user asked to change them.\n"
        "3. Copy old_text verbatim from the file (no line-number prefixes, no markdown fences). "
        "Include enough surrounding context so old_text is unique in the file.\n"
        "4. Write summary as one concise sentence in the language of the user's instruction.\n"
        "5. Never fabricate an edit if the passage cannot be found in editable LaTeX source; "
        "instead explain clearly why it could not be located.",
    ])


SNIPPET_EDIT_FINAL_ANSWER_PROMPT = (
    "Your tool budget is spent and no tools are available any more. If you already "
    "recorded a valid edit with propose_latex_edit, confirm it briefly. Otherwise "
    "explain concisely why the passage could not be located or edited."
)


def build_snippet_edit_prompt(
    excerpt: str,
    instruction: str,
    source: SnippetEditSource,
    hint: SynctexHint | None,
) -> str:
    lines: list[str] = []
    if source.document_path:
        lines.append(f"PDF document: {source.document_path}")
    if source.source_file:
        lines.append(f"Associated LaTeX file: {source.source_file}")
    if source.page:
        lines.append(
            f"Page: {source.page} of {source.total_pages}" if source.total_pages else f"Page: {source.page}"
        )
    if hint:
        lines.extend([
            f"SyncTeX hint: {hint.rel_file} around line {hint.line} "
            f"(note: SyncTeX often points to the end of the paragraph or environment).",
            f"Verbatim source window ({hint.rel_file}, lines {hint.window_start}-{hint.window_end}):",
            "<source_window>",
            hint.window_text,
            "</source_window>",
        ])
    lines.extend([
        "",
        "Selected PDF excerpt (rendered text, not raw LaTeX):",
        "<excerpt>",
        excerpt,
        "</excerpt>",
        "",
        "Requested change:",
        instruction,
    ])
    return "\n".join(lines).lstrip("\n")


async def execute_snippet_edit_proposal(
    excerpt: str,
    instruction: str,
    *,
    source: SnippetEditSource | None = None,
    project_path: str,
    model: str | None = None,
    main_file: str = "",
    last_synctex_path: str = "",
    max_tokens: int = 4096,
) -> SnippetEditProposal:
    """Locate the selected PDF excerpt in LaTeX source and return a validated edit proposal."""
    text = str(excerpt or "").strip()
    asked = str(instruction or "").strip()
    if not text:
        raise SnippetEditError("Editing an excerpt requires a non-empty selection.")
    if not asked:
        raise SnippetEditError("Describe what you want to change first.")
    if len(text) > MAX_EDIT_EXCERPT_CHARS:
        raise SnippetEditError(
            f"The selected excerpt is too long ({len(text)} characters, limit {MAX_EDIT_EXCERPT_CHARS})."
        )
    if len(asked) > MAX_EDIT_INSTRUCTION_CHARS:
        raise SnippetEditError(
            f"The change description is too long ({len(asked)} characters, limit {MAX_EDIT_INSTRUCTION_CHARS})."
        )
    if not project_path or not os.path.isdir(project_path):
        raise SnippetEditError("An open project is required to edit LaTeX source.")

    src = source or SnippetEditSource()
    hint = resolve_synctex_hint(
        project_path,
        src,
        main_file=main_file,
        last_synctex_path=last_synctex_path,
    )

    import agenticblocks.blocks.llm.agent as _agent_mod
    from agenticblocks.core.function_block import as_tool
    from opalatex.config import (
        get_agent_llm_kwargs,
        get_agent_model,
        normalize_ollama_api_base_for_litellm,
        resolve_model_route,
    )
    from opalatex.litellm_compat import wrap_agent_litellm_compat
    from opalatex.memgpt_runtime import _NATIVE_TOOL_CALL_REMINDER, _needs_native_tool_call_reminder
    from opalatex.translation import strip_model_reasoning

    reader = ProjectReader(project_path)
    files_read: list[str] = []
    if hint:
        files_read.append(hint.rel_file)

    recorded: dict[str, SnippetEditProposal | None] = {"proposal": None}

    @as_tool(
        name="propose_latex_edit",
        description=(
            "Validate and record a proposed verbatim replacement in a project LaTeX file "
            "without writing to disk. old_text must match the target file verbatim and "
            "uniquely. Call this once you have the exact source."
        ),
    )
    def propose_latex_edit(file_path: str, old_text: str, new_text: str, summary: str = "") -> str:
        real, rel_file = _ensure_editable_latex_path(reader, file_path)
        current = _read_raw_source(real, rel_file)
        updated, start_line, end_line = replace_unique_verbatim(current, old_text, new_text)
        diff_lines, added, removed, diff_start, diff_end = build_structured_diff(current, updated)
        recorded["proposal"] = SnippetEditProposal(
            target_file=rel_file,
            old_text=old_text,
            new_text=new_text,
            summary=str(summary or "").strip(),
            base_sha256=compute_text_sha256(current),
            start_line=diff_start or start_line,
            end_line=diff_end or end_line,
            added=added,
            removed=removed,
            diff_lines=diff_lines,
            files_read=list(files_read),
            synctex_file=hint.rel_file if hint else "",
            synctex_line=hint.line if hint else None,
        )
        return (
            f"Proposal validated for {rel_file} (lines {diff_start}-{diff_end}, "
            f"+{added}/-{removed}). Stop now and confirm the proposal briefly."
        )

    tools = [*reader.tools(), propose_latex_edit]

    selected_model = str(model or "").strip()
    model_kwargs = get_agent_llm_kwargs(
        "orchestrator",
        model_override=selected_model or None,
        reasoning_effort_override=SNIPPET_EDIT_REASONING_EFFORT,
    )
    if not selected_model:
        selected_model = get_agent_model("orchestrator")
    try:
        model_kwargs["max_tokens"] = max(1, min(65536, int(max_tokens)))
    except (TypeError, ValueError):
        model_kwargs["max_tokens"] = 4096
    selected_model = resolve_model_route(selected_model, model_kwargs)
    if model_kwargs.get("api_base"):
        model_kwargs["api_base"] = normalize_ollama_api_base_for_litellm(
            selected_model,
            model_kwargs["api_base"],
        )

    system_prompt = build_snippet_edit_system_prompt()
    if _needs_native_tool_call_reminder(selected_model):
        system_prompt += "\n" + _NATIVE_TOOL_CALL_REMINDER

    def _record_reads(_iteration, messages):
        for message in messages:
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                if function.get("name") != "read_project_file":
                    continue
                try:
                    path = json.loads(function.get("arguments") or "{}").get("path")
                except (TypeError, ValueError, AttributeError):
                    continue
                if path and str(path) not in files_read:
                    files_read.append(str(path))

    agent = _agent_mod.LLMAgentBlock(
        name="snippet_edit",
        system_prompt=system_prompt,
        model=selected_model,
        model_kwargs=model_kwargs,
        tools=tools,
        max_tool_calls=SNIPPET_EDIT_MAX_TOOL_CALLS,
        max_iterations=SNIPPET_EDIT_MAX_ITERATIONS,
        on_max_iterations="return_last",
        final_answer_prompt=SNIPPET_EDIT_FINAL_ANSWER_PROMPT,
        on_iteration=_record_reads,
    )
    wrap_agent_litellm_compat(agent)
    res = await agent.run(
        _agent_mod.AgentInput(
            prompt=build_snippet_edit_prompt(text, asked, src, hint),
        )
    )

    proposal = recorded["proposal"]
    if proposal is None:
        raw_reason = strip_model_reasoning(str(getattr(res, "final_text", "") or "")).strip()
        if raw_reason:
            raise SnippetEditError(raw_reason)
        if getattr(res, "budget_exhausted", False):
            raise SnippetEditError(
                f"The assistant reached its step limit ({SNIPPET_EDIT_MAX_TOOL_CALLS} tool calls) "
                "without producing a valid LaTeX edit. Try selecting a slightly longer passage."
            )
        raise SnippetEditError(
            "The assistant could not produce a verified LaTeX edit for the selected excerpt."
        )

    proposal.files_read = list(files_read)
    return proposal


def _resolve_compile_root(
    project_path: str,
    abs_target: str,
    target_content: str,
    *,
    pdf_path: str = "",
    main_file: str = "",
) -> tuple[str, str]:
    """Choose the root .tex file to compile after editing *abs_target*."""
    from opalatex.latex_compiler import determine_main_file_for_compilation, find_pdf_source_tex

    if pdf_path:
        standalone_root = find_pdf_source_tex(project_path, pdf_path)
        if standalone_root:
            abs_root = os.path.abspath(os.path.join(project_path, standalone_root))
            return standalone_root, abs_root

    resolved_main = determine_main_file_for_compilation(
        abs_target,
        target_content,
        project_path,
        main_file,
    )
    if resolved_main:
        return resolved_main, os.path.abspath(os.path.join(project_path, resolved_main))
    rel = os.path.relpath(abs_target, project_path).replace("\\", "/")
    return rel, abs_target


def _prepare_compile_root(
    project_path: str,
    abs_target: str,
    target_content: str,
    *,
    pdf_path: str = "",
    main_file: str = "",
) -> tuple[str, str, str | None]:
    """Resolve and read the compile root *before* anything is written.

    Returns ``(compiled_main, abs_root, root_content)``; ``root_content`` is
    ``None`` when the root is the edited file itself (its new content is then
    compiled). Reading the root up front means an unreadable root is refused
    while the target file is still untouched.
    """
    compiled_main, abs_root = _resolve_compile_root(
        project_path,
        abs_target,
        target_content,
        pdf_path=pdf_path,
        main_file=main_file,
    )
    if os.path.normcase(abs_root) == os.path.normcase(abs_target):
        return compiled_main, abs_root, None
    return compiled_main, abs_root, _read_raw_source(abs_root, compiled_main)


def _run_compile(
    project_path: str,
    compiled_main: str,
    abs_root: str,
    root_content: str,
) -> dict[str, Any]:
    from opalatex.latex_compiler import compile_latex

    # Always keep synctex=True so subsequent PDF-based edits remain anchored.
    return compile_latex(
        root_content,
        abs_root,
        compiled_main,
        project_path,
        include_pdf_base64=False,
        draft=False,
        synctex=True,
    )


def apply_snippet_edit(
    project_path: str,
    target_file: str,
    old_text: str,
    new_text: str,
    base_sha256: str,
    *,
    pdf_path: str = "",
    main_file: str = "",
) -> SnippetEditApplyResult:
    """Write a confirmed proposal to disk and recompile the associated LaTeX document."""
    if not project_path or not os.path.isdir(project_path):
        raise SnippetEditError("Project directory not found.")
    if not base_sha256:
        raise SnippetEditError("baseSha256 is required to apply an edit safely.")

    reader = ProjectReader(project_path)
    real, rel_file = _ensure_editable_latex_path(reader, target_file)
    current = _read_raw_source(real, rel_file)
    if compute_text_sha256(current) != base_sha256:
        raise SnippetEditConflictError(
            f"'{rel_file}' changed on disk since this diff was generated. "
            "Generate the proposal again before applying."
        )

    updated, start_line, end_line = replace_unique_verbatim(current, old_text, new_text)
    compiled_main, abs_root, root_content = _prepare_compile_root(
        project_path,
        real,
        updated,
        pdf_path=pdf_path,
        main_file=main_file,
    )
    with open(real, "w", encoding="utf-8", newline="") as handle:
        handle.write(updated)

    compile_result = _run_compile(
        project_path,
        compiled_main,
        abs_root,
        updated if root_content is None else root_content,
    )
    return SnippetEditApplyResult(
        target_file=rel_file,
        compiled_main_file=compiled_main,
        compile_success=bool(compile_result.get("success")),
        compile_log=str(compile_result.get("log") or ""),
        new_content=updated,
        previous_content=current,
        new_sha256=compute_text_sha256(updated),
        start_line=start_line,
        end_line=end_line,
        pdf_path=str(compile_result.get("pdf_path") or ""),
        synctex_path=str(compile_result.get("synctex_path") or ""),
    )


def revert_snippet_edit(
    project_path: str,
    target_file: str,
    expected_sha256: str,
    previous_content: str,
    *,
    pdf_path: str = "",
    main_file: str = "",
) -> SnippetEditApplyResult:
    """Restore *previous_content* when the file still matches *expected_sha256* and recompile."""
    if not project_path or not os.path.isdir(project_path):
        raise SnippetEditError("Project directory not found.")
    if not expected_sha256:
        raise SnippetEditError("expectedSha256 is required to revert an edit safely.")

    reader = ProjectReader(project_path)
    real, rel_file = _ensure_editable_latex_path(reader, target_file)
    current = _read_raw_source(real, rel_file)
    if compute_text_sha256(current) != expected_sha256:
        raise SnippetEditConflictError(
            f"'{rel_file}' has been modified since the edit was applied, so it was not reverted."
        )

    compiled_main, abs_root, root_content = _prepare_compile_root(
        project_path,
        real,
        previous_content,
        pdf_path=pdf_path,
        main_file=main_file,
    )
    with open(real, "w", encoding="utf-8", newline="") as handle:
        handle.write(previous_content)

    compile_result = _run_compile(
        project_path,
        compiled_main,
        abs_root,
        previous_content if root_content is None else root_content,
    )
    return SnippetEditApplyResult(
        target_file=rel_file,
        compiled_main_file=compiled_main,
        compile_success=bool(compile_result.get("success")),
        compile_log=str(compile_result.get("log") or ""),
        new_content=previous_content,
        previous_content=current,
        new_sha256=compute_text_sha256(previous_content),
        start_line=1,
        end_line=1,
        pdf_path=str(compile_result.get("pdf_path") or ""),
        synctex_path=str(compile_result.get("synctex_path") or ""),
    )
