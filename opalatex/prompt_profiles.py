"""Prompt-profile registry for the OpalaTex agent runtime.

A "prompt profile" controls how verbose the chat-orchestrator and worker
system prompts are. ``full`` is the unabridged prompt, aimed at large/capable
models. ``light`` renders a condensed prompt for models that don't need (or
can't reliably follow) the full guardrail prose, saving context tokens and
latency. The two differ in length, never in what they instruct: a rule changed
in one is changed in the other.

Each role resolves its own profile from the model assigned to it
(``opalatex/config.py: model_prompt_profile``, mirroring how
``supports_thinking`` is resolved per model in ``opalatex/models_store.py``),
so the chat-orchestrator and a delegated worker can run under different
profiles in the same turn if they use different models.

Skills can ship a profile-specific body by adding a ``SKILL.<profile>.md``
file next to their ``SKILL.md`` (see ``opalatex/skills.py: parse_skill_md``).
Frontmatter (name/description/model/extends) always comes from the canonical
``SKILL.md``; only the body (Level-2 instructions) is overridden.

Adding a third profile is registering one more entry in ``PROMPT_PROFILES``
below; no call site elsewhere in the codebase needs to change.

A profile says how *verbose* a prompt is, never what an agent is *allowed to
do*. Whether the chat-orchestrator may write files at all is a separate,
orthogonal per-model field (``orchestrator_policy``, see
``opalatex/config.py: model_orchestrator_policy``), so that "light prompt,
delegate writes" stays expressible. Do not fold authority into this registry.
"""
from __future__ import annotations

import re

DEFAULT_PROFILE = "full"


# ---------------------------------------------------------------------------
# full profile — the unabridged instructions (originally extracted from the
# inline strings in memgpt_runtime.py).
# ---------------------------------------------------------------------------

def _full_mode_instructions(mode: str) -> str:
    if mode == "plan":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'plan' mode.**\n"
            "INSTRUCTIONS: Your goal is to gather context and propose a plan. "
            "Shell commands, Python scripts and all workspace writes are unavailable, even for diagnostics. Memory writes remain allowed. Use inspect_git, inspect_project, read_document, search_code and read_content_pos to investigate. Tests and project code execution require explicit plan approval. "
            "You MUST NOT call run_skill in plan mode because workers can modify files. "
            "Once you have enough context, you MUST use the `create_plan` tool to present your plan for user approval.\n"
        )
    if mode == "edit":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'edit' mode.**\n"
            "INSTRUCTIONS: You should focus on editing files and answering questions. "
            "Tools that write files or run commands show the user a confirmation dialog before they execute, "
            "so call them directly: do not ask for permission separately first, and if the user denies a tool, do not retry it.\n"
        )
    if mode == "auto":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'auto' mode.**\n"
            "INSTRUCTIONS: Potentially dangerous tools (file edits, terminal execution) are pre-authorized without safety confirmation dialogs. "
            "However, this DOES NOT mean you should guess user preferences or avoid interaction. "
            "Use `ask_question` whenever collecting user choices, column selections, target formats, or ambiguous preferences will produce a better result.\n"
        )
    return ""


def _full_worker_intro() -> str:
    return (
        "Use your available tools and skills "
        "to fulfill the user's request provided in your context. "
        "\n--- WORKER RESPONSE CONTRACT ---\n"
        "Use native provider tool calls only when an action is required. If the task requires reading, editing, or executing something, make the appropriate native tool call before reporting completion.\n"
        "Never serialize a tool call as JSON or Markdown text. If no action is needed or the work is complete, return a concise normal-text report.\n"
        "--------------------------------------------\n\n"
    )


# Usage guidance for the tools a worker is most often wrong about, in the order
# they are listed. Every other tool the worker actually receives is listed after
# these with its own description, so the block can never claim a smaller toolset
# than the one the model was given: it used to say "Your specific tools are:"
# over 14 names while the worker held 24, including the presentation tools the
# tex-to-jpt skill tells it to call.
_FULL_WORKER_TOOL_GUIDANCE = {
    "get_project_overview": "Returns the project's folder and file structure. Use it only when the target file is unknown.",
    "search_code": "Searches project files using Python and returns matching paths with line numbers. Use it to locate sections, labels, definitions, or markers before line-based reads/edits.",
    "read_file": "Reads the complete contents of a file, including the text of PDF/DOCX/PPTX/XLSX documents. Use it only for small files or when full-file context is truly needed.",
    "read_content_pos": "Reads a specific snippet of a file by providing start and end line numbers. Use it for targeted reading of large files.",
    "get_editor_state": "Reports the user's open editor tabs, focused file, and current text selection. Use it when the task refers to the open file or the selection instead of a named path.",
    "write_file": "Creates a file or completely overwrites one. Use it to create new files or replace small ones entirely; for a large existing file, edit the needed range instead. NEVER use run_command with echo/cat to write files.",
    "write_content_pos": "Inserts content before a specific 1-indexed line in an existing file.",
    "replace_content_range": "Replaces an inclusive 1-indexed line range in an existing file. Use it for surgical edits to large files.",
    "create_docx_file": "Creates a Word .docx file from Markdown-like text. Use it instead of writing raw binary DOCX content.",
    "create_pptx_file": "Creates a PowerPoint .pptx file from a JSON slide outline. Use it instead of writing raw binary PPTX content.",
    "run_command": "Executes terminal commands (e.g., running tests, build scripts, or exploring the OS). Use it to interact with the environment and validate code.",
    "run_python_script": "Runs a Python script with the interpreter this environment actually uses, instead of guessing between python and python3. Use it for a skill's own processor script.",
    "search_conversation_history": "Searches past interactions. Use it to recall previous decisions, context, or code snippets from the chat history.",
    "ask_question": "Asks the user a clarifying question or requests preferences/inputs during execution and waits for their response. Use it whenever you need user clarification or choices before proceeding.",
}


def _ordered_tool_names(tools) -> list[str]:
    """Names of *tools*, the guided ones first in their usual order."""
    names = [getattr(t, "name", "") for t in tools or []]
    names = [n for n in dict.fromkeys(names) if n]
    guided = [n for n in _FULL_WORKER_TOOL_GUIDANCE if n in names]
    return guided + [n for n in names if n not in _FULL_WORKER_TOOL_GUIDANCE]


def _first_sentence(text: str) -> str:
    """The first sentence of a tool description.

    A sentence ends at terminal punctuation followed by a capital letter, so an
    abbreviation such as "(e.g. `npm create`" does not cut the description short.
    """
    text = " ".join(str(text or "").split())
    return re.split(r"(?<=[.!?])\s+(?=[A-Z])", text, maxsplit=1)[0]


def _full_worker_tools_block(tools) -> str:
    by_name = {getattr(t, "name", ""): t for t in tools or []}
    lines = []
    for name in _ordered_tool_names(tools):
        guidance = _FULL_WORKER_TOOL_GUIDANCE.get(name) or _first_sentence(
            getattr(by_name[name], "description", "")
        )
        lines.append(f"  - {name}: {guidance}\n")
    return "Your tools:\n" + "".join(lines)


def _full_worker_recommendations() -> str:
    return (
        "RECOMMENDATION FOR EXECUTION AND TERMINATION:\n"
        "- Information Gathering Rule: Using ask_question to request preferred columns, formats, seed filters, or specific focus metrics from the user is an EXPECTED and RECOMMENDED behavior. It does not reduce your autonomy; it ensures execution matches user intent.\n"
        "- If requirements, parameters, target columns, formats, or file choices are underspecified or ambiguous, use the ask_question tool to ask the user before executing destructive or arbitrary changes.\n"
        "- If MEMGPT CONTEXT/INSTRUCTIONS contains an explicit command or script to execute, use run_command as the first native tool call.\n"
        "- If MEMGPT CONTEXT/INSTRUCTIONS already identifies the target file, line range, or edit, do not call get_project_overview first.\n"
        "- For large .tex, .log, or source files, never call read_file just to find a section or marker; use search_code to locate the marker, then read_content_pos for the returned line range.\n"
        "- Complete required actions through native tool calls, then return a concise normal-text report.\n"
        "- Do not claim that a modification succeeded until the relevant tool has succeeded.\n"
        "CRITICAL THINKING RULE: Keep your internal reasoning extremely brief and concise. DO NOT enter infinite brainstorming loops (e.g. repeatedly asking yourself 'Should I do X? Yes/No. Wait!'). Formulate a quick plan and IMMEDIATELY execute a tool or return.\n"
    )


ACHIEVEMENTS_POLICY = (
    "Record a milestone with 'update_achievements_memory' only in the same response as the "
    "action it records, never as a step of its own, and skip it when your step budget is low: "
    "finishing the work and reporting it matters more than logging it."
)
"""Shared by both profiles and mirrored in the orchestrator's SKILL.md variants.

The old wording ("Use it FREQUENTLY", "MUST record", "concluded a heartbeat/
iteration") made bookkeeping a step of its own. Traced in real turns cut short
by the step budget: the last heartbeat went to recording progress, and the
model never got to report the work it had finished."""


def _full_achievements_instructions() -> str:
    return (
        "ACHIEVEMENTS MEMORY INSTRUCTION:\n"
        f"{ACHIEVEMENTS_POLICY}\n"
        "Milestones worth recording: the location of an important file or snippet, a file "
        "successfully written, the root cause of an error or bug.\n"
    )


# ---------------------------------------------------------------------------
# light profile — same invariants (tool-call contract, skill catalog
# authority, mode gating, large-file paging rules), condensed prose. The
# structural safety nets (loop detection, failed-delegation breakers,
# serialized-tool-call sanitization) live in code, not in prompt length, so
# trimming persuasive repetition here does not remove them.
# ---------------------------------------------------------------------------

def _light_mode_instructions(mode: str) -> str:
    if mode == "plan":
        return "\nMode: plan. Read and diagnose only; no workspace writes, shell, Python execution or run_skill. Memory writes remain allowed. Use inspect_git, inspect_project, read_document, search_code and read_content_pos. Call create_plan when ready; execution tools become available only after explicit approval.\n"
    if mode == "edit":
        return "\nMode: edit. Focus on file edits and questions. Write and command tools ask the user to confirm on their own: call them directly, without asking beforehand, and do not retry a denied tool.\n"
    if mode == "auto":
        return "\nMode: auto. File edits and terminal execution are pre-authorized; still use ask_question for ambiguous choices.\n"
    return ""


def _light_worker_intro() -> str:
    # The skill is named once, by the shared tail of the worker prompt
    # (`build_run_skill_tool`), for both profiles.
    return (
        "Use native tool calls for actions, "
        "never as JSON/Markdown text. Finish with a concise normal-text report.\n\n"
    )


def _light_worker_tools_block(tools) -> str:
    names = [
        f"{name} (also extracts text from PDF/DOCX/PPTX/XLSX)" if name == "read_file" else name
        for name in _ordered_tool_names(tools)
    ]
    return "Tools: " + ", ".join(names) + ".\n"


def _light_worker_recommendations() -> str:
    return (
        "Ask via ask_question when requirements are ambiguous. Use search_code before read_content_pos "
        "on large files; never call read_file just to locate a marker. Do not claim success before the "
        "relevant tool call has actually succeeded. Keep reasoning brief and act.\n"
    )


def _light_achievements_instructions() -> str:
    return f"{ACHIEVEMENTS_POLICY}\n"


PROMPT_PROFILES: dict[str, dict] = {
    "full": {
        "mode_instructions": _full_mode_instructions,
        "worker_intro": _full_worker_intro,
        "worker_tools_block": _full_worker_tools_block,
        "worker_recommendations": _full_worker_recommendations,
        "achievements_instructions": _full_achievements_instructions,
    },
    "light": {
        "mode_instructions": _light_mode_instructions,
        "worker_intro": _light_worker_intro,
        "worker_tools_block": _light_worker_tools_block,
        "worker_recommendations": _light_worker_recommendations,
        "achievements_instructions": _light_achievements_instructions,
    },
}


def get_profile(name: str | None) -> dict:
    """Return the profile spec dict for *name*, falling back to ``full``."""
    return PROMPT_PROFILES.get((name or "").strip().lower()) or PROMPT_PROFILES[DEFAULT_PROFILE]
