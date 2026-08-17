"""Prompt-profile registry for the OpalaTex agent runtime.

A "prompt profile" controls how verbose the chat-orchestrator and worker
system prompts are. ``full`` is the original, unabridged prompt this project
has always shipped, aimed at large/capable models and left byte-for-byte
unchanged by this module. ``light`` renders a condensed prompt for models
that don't need (or can't reliably follow) the full guardrail prose, saving
context tokens and latency.

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
"""
from __future__ import annotations

DEFAULT_PROFILE = "full"


# ---------------------------------------------------------------------------
# full profile — text extracted verbatim from the original inline strings in
# memgpt_runtime.py, so a model resolving to "full" (the default) never sees
# a different prompt than before this module existed.
# ---------------------------------------------------------------------------

def _full_mode_instructions(mode: str) -> str:
    if mode == "plan":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'plan' mode.**\n"
            "INSTRUCTIONS: Your goal is to gather context and propose a plan. "
            "You MUST NOT execute modifying tools (like editing files or running terminal commands). "
            "You MUST NOT call run_skill in plan mode because workers can modify files. "
            "Once you have enough context, you MUST use the `create_plan` tool to present your plan for user approval.\n"
        )
    if mode == "edit":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'edit' mode.**\n"
            "INSTRUCTIONS: You should focus on editing files and answering questions. "
            "If an action requires terminal execution or long-running tasks, ask the user for permission first.\n"
        )
    if mode == "auto":
        return (
            "\n🚨 **SYSTEM ALERT: You are currently in 'auto' mode.**\n"
            "INSTRUCTIONS: Potentially dangerous tools (file edits, terminal execution) are pre-authorized without safety confirmation dialogs. "
            "However, this DOES NOT mean you should guess user preferences or avoid interaction. "
            "Use `ask_question` whenever collecting user choices, column selections, target formats, or ambiguous preferences will produce a better result.\n"
        )
    return ""


def _full_worker_intro(skill_name: str) -> str:
    return (
        "Use your available tools and skills "
        "to fulfill the user's request provided in your context. "
        "\n--- WORKER RESPONSE CONTRACT ---\n"
        "Use native provider tool calls only when an action is required. If the task requires reading, editing, or executing something, make the appropriate native tool call before reporting completion.\n"
        "Never serialize a tool call as JSON or Markdown text. If no action is needed or the work is complete, return a concise normal-text report.\n"
        "--------------------------------------------\n\n"
    )


def _full_worker_tools_block() -> str:
    return (
        "Your specific tools are:\n"
        "  - get_project_overview: Returns the project's folder and file structure. Use it only when the target file is unknown.\n"
        "  - search_code: Searches project files using Python and returns matching paths with line numbers. Use it to locate sections, labels, definitions, or markers before line-based reads/edits.\n"
        "  - read_file: Reads the complete contents of a file. Use it only for small files or when full-file context is truly needed.\n"
        "  - read_content_pos: Reads a specific snippet of a file by providing start and end line numbers. Use it for targeted reading of large files.\n"
        "  - write_file: Writes or completely overwrites a file. Use it to create new files or replace existing ones entirely. NEVER use run_command with echo/cat to write files.\n"
        "  - write_content_pos: Inserts content before a specific 1-indexed line in an existing file.\n"
        "  - replace_content_range: Replaces an inclusive 1-indexed line range in an existing file. Use it for surgical edits to large files.\n"
        "  - create_docx_file: Creates a Word .docx file from Markdown-like text. Use it instead of writing raw binary DOCX content.\n"
        "  - create_pptx_file: Creates a PowerPoint .pptx file from a JSON slide outline. Use it instead of writing raw binary PPTX content.\n"
        "  - run_command: Executes terminal commands (e.g., running tests, build scripts, or exploring the OS). Use it to interact with the environment and validate code.\n"
        "  - search_conversation_history: Searches past interactions. Use it to recall previous decisions, context, or code snippets from the chat history.\n"
        "  - ask_question: Asks the user a clarifying question or requests preferences/inputs during execution and waits for their response. Use it whenever you need user clarification or choices before proceeding.\n"
    )


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


def _full_achievements_instructions() -> str:
    return (
        "ACHIEVEMENTS MEMORY INSTRUCTION:\n"
        "You have access to the 'update_achievements_memory' tool. Use it FREQUENTLY to record your progress and milestones.\n"
        "Examples of achievements you MUST record:\n"
        "1. Discovered the location of an important file or snippet.\n"
        "2. Concluded a heartbeat/iteration (write a summary of what you did in that phase).\n"
        "3. Successfully read and understood a file's contents, or successfully wrote to a file.\n"
        "4. Discovered the root cause of an error or bug.\n"
        "You can output MULTIPLE tool calls in the same response to update achievements alongside your main action.\n"
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
        return "\nMode: plan. Gather context only, no file edits or run_skill. Call create_plan when ready.\n"
    if mode == "edit":
        return "\nMode: edit. Focus on file edits and questions; ask before terminal execution or long tasks.\n"
    if mode == "auto":
        return "\nMode: auto. File edits and terminal execution are pre-authorized; still use ask_question for ambiguous choices.\n"
    return ""


def _light_worker_intro(skill_name: str) -> str:
    return (
        f"Executing the '{skill_name}' skill. Use native tool calls for actions, "
        "never as JSON/Markdown text. Finish with a concise normal-text report.\n\n"
    )


def _light_worker_tools_block() -> str:
    return (
        "Tools: get_project_overview, search_code, read_file, read_content_pos, write_file, "
        "write_content_pos, replace_content_range, create_docx_file, create_pptx_file, run_command, "
        "search_conversation_history, ask_question.\n"
    )


def _light_worker_recommendations() -> str:
    return (
        "Ask via ask_question when requirements are ambiguous. Use search_code before read_content_pos "
        "on large files; never call read_file just to locate a marker. Do not claim success before the "
        "relevant tool call has actually succeeded. Keep reasoning brief and act.\n"
    )


def _light_achievements_instructions() -> str:
    return "Call update_achievements_memory for milestones (file found, iteration done, bug root cause).\n"


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
