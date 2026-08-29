"""MemGPT runtime for the skills-oriented architecture (docs/specs/02, 06).

This module assembles the fixed **MemGPT chat-orchestrator** and the machinery it
uses to delegate work to skills:

  - ``build_run_skill_tool(memgpt, project_path)`` returns a ``run_skill`` tool
    bound to a MemGPT instance. When the MemGPT calls it, an ephemeral sub-agent
    (LLMAgentBlock) is spawned with the skill's SKILL.md body as its system prompt
    and the workflow tools available, plus an **intercepted** ``send_message``.
  - The interceptor (a wrapper around the sub-agent's ``send_message``) records
    worker messages as diagnostic info and buffers them for the ``run_skill`` tool
    result. The chat-orchestrator remains responsible for the final user-facing
    ``send_message``.
  - ``build_chat_orchestrator(project, store)`` builds the MemGPT itself: the
    framework ``MemGPTAgentBlock`` primed with the ``chat-orchestrator`` SKILL.md,
    the Level-1 metadata of the active skills, the ``run_skill`` tool, and the
    memory tools.

The module is additive: the legacy intent-routing path in cli.py is untouched
until the REPL is switched over (Phase 4).
"""
from __future__ import annotations
from datetime import datetime
from opalatex.tools import read_file
from opalatex.tools import get_project_overview
import asyncio
import json
import os
import re
from typing import Any

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import (
    MemGPTAgentBlock,
    is_empty_response_placeholder,
)
# pyrefly: ignore [missing-import]
from agenticblocks.core.function_block import as_tool

from . import terminal as T

from .tools import (
    #ask_human,
    read_core_memory,
    append_core_memory,
    search_conversation_history,
    search_code,
    web_search,
    analyze_image,
    read_content_pos,
    get_editor_state,
    set_project_context,
)
from .config import (
    DEFAULT_MODEL,
    WORKER_MODEL,
    get_agent_llm_kwargs,
    get_agent_max_heartbeats,
    get_agent_model,
    get_agent_response_mode,
    get_project_agent_params,
)
from .skills import (
    active_skills,
    find_skill_dir,
    level1_metadata,
    parse_skill_md,
    MANDATORY_SKILLS,
)

from .tools import get_available_tools
from .project import tutorial_chat_id

CHAT_ORCHESTRATOR_SKILL = "chat-orchestrator"
MAX_FAILED_SKILL_ATTEMPTS = 2
MAX_FAILED_DELEGATIONS = 3


_SERIALIZED_TOOL_CALL_MARKER = (
    "[WORKER PROTOCOL ERROR: the worker serialized a tool call as text instead of "
    "invoking it, so this attempt produced no result.]"
)
_BROKEN_SERIALIZATION_MARKER = (
    "[WORKER PROTOCOL ERROR: the worker emitted a structured payload as text and "
    "did not close it, so this attempt produced no usable report.]"
)


# Chat-template markup for a tool call, which weak models emit as plain content
# when their native calls keep being rejected. `<tool_call>` is the Hermes/Qwen
# wrapper; `<function=name>` is the element Qwen-Coder-style templates use inside
# it, and which some models emit on its own. Both are matched lazily so a run of
# several blocks is cut one at a time, and both accept a missing closing tag so a
# truncated block is still recognized.
_MARKUP_TOOL_CALL_RE = re.compile(
    r"<(?P<tag>tool_call|function_call)\b[^>]*>.*?(?:</(?P=tag)\s*>|\Z)",
    re.DOTALL | re.IGNORECASE,
)
_MARKUP_FUNCTION_CALL_RE = re.compile(
    r"<function\s*=\s*[^<>\s]+\s*>.*?(?:</function\s*>|\Z)",
    re.DOTALL | re.IGNORECASE,
)


def _is_tool_call_payload(value: Any) -> bool:
    """True when parsed JSON has the shape of a tool call rather than of data."""
    if isinstance(value, list):
        return any(_is_tool_call_payload(item) for item in value)
    if not isinstance(value, dict):
        return False
    if "tool_calls" in value:
        return True
    function = value.get("function")
    if isinstance(function, dict) and isinstance(function.get("name"), str):
        return True
    if isinstance(value.get("tool_name"), str):
        return True
    return isinstance(value.get("name"), str) and (
        "arguments" in value or "parameters" in value
    )


def _iter_json_spans(text: str):
    """Yield ``(start, end)`` spans of balanced ``{...}``/``[...]`` blocks in ``text``."""
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in "{[":
            if depth == 0:
                start = index
            depth += 1
        elif char in "}]" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                yield start, index + 1
                start = -1


def _iter_serialized_tool_call_spans(text: str):
    """Yield ``(start, end)`` spans of every tool call written as text.

    A tool call is serialized in one of two encodings, and only the JSON one used
    to be recognized. Qwen-family models served locally fall back to their chat
    template's markup instead -- ``<tool_call>`` wrapping either a JSON payload or
    ``<function=name>``/``<parameter=key>`` elements -- which carries no JSON
    object for `_iter_json_spans` to find. Both encodings are plain text, so
    neither executes, and both must be caught the same way.

    An unterminated block still counts: a truncated ``<tool_call>`` is a call the
    model failed to issue, not prose.
    """
    for pattern in (_MARKUP_TOOL_CALL_RE, _MARKUP_FUNCTION_CALL_RE):
        for match in pattern.finditer(text):
            yield match.start(), match.end()
    for start, end in _iter_json_spans(text):
        try:
            parsed = json.loads(text[start:end])
        except Exception:
            continue
        if _is_tool_call_payload(parsed):
            yield start, end


def _merge_spans(spans) -> list[tuple[int, int]]:
    """Merge overlapping and nested spans so no region is excised twice.

    A ``<tool_call>`` block normally contains a ``<function=...>`` element or a
    JSON payload, so the same text is reported by more than one scanner.
    """
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _strip_serialized_tool_calls(text: str) -> tuple[str, bool]:
    """Replace a tool call emitted as text with a fixed marker.

    Weak local models sometimes print a tool call instead of issuing it, as JSON
    or as chat-template markup. Replaying that payload verbatim into the next
    worker prompt teaches the next model to do the same, so the payload never
    reaches a prompt — only the marker does.
    """
    spans = _merge_spans(_iter_serialized_tool_call_spans(text))
    if not spans:
        return text, False

    kept: list[str] = []
    cursor = 0
    for start, end in spans:
        kept.append(text[cursor:start])
        cursor = end
    kept.append(text[cursor:])
    cleaned = " ".join(part.strip() for part in kept if part.strip())
    return (f"{cleaned} {_SERIALIZED_TOOL_CALL_MARKER}".strip() if cleaned
            else _SERIALIZED_TOOL_CALL_MARKER), True


def _is_broken_serialization(text: str) -> bool:
    """True when a report opens as a JSON document but does not parse as one.

    That is a failed serialization, not a summary: the model started emitting a
    structured payload as text and truncated it.
    """
    stripped = text.strip()
    if not stripped.startswith(("{", "[")):
        return False
    if not re.search(r'"\s*:', stripped):
        return False
    try:
        json.loads(stripped)
    except Exception:
        return True
    return False


def _is_failed_worker_result(result: Any) -> bool:
    text = str(result or "")
    if not text.strip():
        return True
    lowered = text.lower()
    if (
        "[critical worker crash]" in lowered
        or "[aviso: o worker terminou sem um resumo claro" in lowered
        or "tools used by worker: 0" in lowered
        or "0 chamadas de ferramenta" in lowered
        or "tool-call json parsing failed" in lowered
        or "worker protocol error" in lowered
    ):
        return True
    # A report that is a serialized tool call, or a JSON document the model never
    # closed, carries no summary: the delegation produced nothing usable and must
    # count towards the loop breaker instead of resetting it.
    _, has_tool_call_payload = _strip_serialized_tool_calls(text)
    return has_tool_call_payload or _is_broken_serialization(text)


def _recent_failed_skill_attempts(memgpt: MemGPTAgentBlock, skill_name: str) -> int:
    attempts = 0
    for run in reversed(getattr(memgpt, "_skill_run_history", [])):
        if run.get("skill") != skill_name:
            break
        if not _is_failed_worker_result(run.get("result", "")):
            break
        attempts += 1
    return attempts


def _recent_failed_delegations(memgpt: MemGPTAgentBlock) -> int:
    """Count trailing failed delegations regardless of which skill ran them.

    ``_recent_failed_skill_attempts`` stops at the first entry belonging to another
    skill, so alternating between two skills keeps its count at zero forever. An
    orchestrator that cannot get a usable report is in the same dead end whether it
    reworded the context or switched specialist, so this counter ignores the name.
    """
    attempts = 0
    for run in reversed(getattr(memgpt, "_skill_run_history", [])):
        if not _is_failed_worker_result(run.get("result", "")):
            break
        attempts += 1
    return attempts


def _sanitize_skill_result_for_prompt(result: Any, *, limit: int = 500) -> str:
    text = str(result or "").strip()
    lowered = text.lower()
    if "error parsing tool call" in lowered and "unexpected end of json input" in lowered:
        return "[CRITICAL WORKER CRASH: model produced invalid/truncated JSON tool-call arguments.]"
    if "[aviso: o worker terminou sem um resumo claro" in lowered:
        return "[WORKER NO-ACTION: worker finished without a clear summary or tool calls.]"
    text, had_tool_call_payload = _strip_serialized_tool_calls(text)
    if not had_tool_call_payload and _is_broken_serialization(text):
        return _BROKEN_SERIALIZATION_MARKER
    if len(text) > limit:
        return text[:limit] + "... [truncated]"
    return text


def _tool_calls_count(tool_calls: Any) -> int | None:
    if isinstance(tool_calls, bool):
        return int(tool_calls)
    if isinstance(tool_calls, int):
        return tool_calls
    if isinstance(tool_calls, str) and tool_calls.isdigit():
        return int(tool_calls)
    return None



def _current_date_instruction(now: datetime | None = None) -> str:
    """Return the dynamic date/freshness instruction prepended to the agent prompt."""
    today = now or datetime.now()
    date_text = f"{today.strftime('%B')} {today.day}, {today.year}"
    return (
        f"Today is {date_text}.\n"
        "TOOL USE - web_search: whenever ANY of the conditions below holds, you MUST "
        "use the web_search tool before answering, refusing, or delegating.\n"
        "1. Unknown or low-confidence terms: the request names a concept, entity, "
        "algorithm, framework, acronym, paper, product, or piece of jargon that you do "
        "not confidently recognize, or that looks misspelled or non-standard. Search it, "
        "including the likely corrected spelling.\n"
        "2. Time-sensitive facts: recent events, current facts, latest/last occurrences, "
        "schedules, releases, versions, public facts that may have changed, or dates that "
        "could be after your training data.\n"
        "3. Verification: precise external data you cannot recall exactly, such as API or "
        "library behavior, benchmark numbers, paper or documentation details, and quotes.\n"
        "Never guess, never invent, and never answer that you have no information about a "
        "topic because it is missing from your training data without searching first. Never "
        "claim that a current, recent, or future-dated event did not happen without first "
        "checking the web.\n"
        "Scope: search public/external knowledge only. Questions about this workspace go to "
        "the project read tools, and anything that depends on the user's preference goes to "
        "ask_question. Stop at the first results good enough to answer."
    )



# ---------------------------------------------------------------------------
# Model resolution for a skill's sub-agent
# ---------------------------------------------------------------------------

def resolve_skill_model(skill_meta: dict, project_model: str | None,
                        project_worker: str | None = None) -> str:
    """Resolve the model for a skill's sub-agent from the SKILL.md `model` field.

    Missing/empty or "worker" (or "alternative") → the project's worker model
    (or the project's main model when the worker model is empty).
    "default" → the project's main model.
    """
    raw = (skill_meta.get("model") or "").strip()
    if not raw:
        return project_worker or project_model or DEFAULT_MODEL
    if raw == "default":
        return project_model or DEFAULT_MODEL
    if raw in ("alternative", "worker"):
        return project_worker or project_model or DEFAULT_MODEL
    return raw


# ---------------------------------------------------------------------------
# Legacy compatibility interceptor
# ---------------------------------------------------------------------------

def make_intercepted_send_message(memgpt: MemGPTAgentBlock, skill_name: str):
    """Return the deprecated worker-report tool for backwards-compatible callers.

    New workers are not given this tool: they return their final report as normal text.
    """

    @as_tool(
        name="send_message",
        description="Legacy compatibility report tool. New workers should return normal text instead.",
    )
    def send_message(message: str) -> str:
        if hasattr(memgpt, "_current_worker_messages"):
            memgpt._current_worker_messages.append(message)
        memgpt._last_worker_chat_response = message
        memgpt._worker_response_emitted = False
        info_message = f"[{skill_name}] {message}"
        try:
            from . import agent_stdin as stdin_mod
            stdin_mod.record_worker_message(message)
            stdin_mod.print_event("info", {"message": info_message})
        except Exception:
            import json
            print(json.dumps({"event": "info", "message": info_message}), flush=True)
        T.console.print(f"\n[bold green]OpalaTex ({skill_name}):[/bold green] {message}\n")
        return "[DONE] legacy message recorded for orchestrator"

    return send_message

# ---------------------------------------------------------------------------
# run_skill tool
# ---------------------------------------------------------------------------

def build_run_skill_tool(
    memgpt: MemGPTAgentBlock,
    project_path: str,
    project_model: str | None = None,
    project_worker: str | None = None,
    _project_ref=None,
    _store_ref=None,
):
    """Return a ``run_skill`` tool bound to *memgpt*.

    Calling ``run_skill(skill_name, context, intent)`` resolves the skill directory,
    reads its SKILL.md (Level 2), spawns an ephemeral LLMAgentBlock sub-agent with
    that body as system prompt and the workflow tools,
    runs it with *context* as the prompt, and returns the sub-agent's result.

    *_project_ref* / *_store_ref* let the tool re-assert the project scope on each
    call (so /load mid-session can't leak writes into the previous project).
    """

    @as_tool(
        name="run_skill",
        description=(
            "Delegate the current task to a registered skill AFTER requirements and user intent are clear. "
            "DO NOT call run_skill on broad, generic, or open-ended user requests (such as 'analise o log', 'melhore o texto', 'processe o arquivo') "
            "before asking the user for their desired focus/preferences via ask_question first. "
            "Pass the skill name (matching one of the active skills under 'Available skills') and a context string. "
            "CRITICAL: You must ONLY call run_skill with a skill name explicitly listed in 'Available skills'. Do NOT invent skill names."
        ),
    )
    async def run_skill(skill_name: str, context: str) -> str:
        # Re-assert project scope so the sub-agent's file/terminal tools act inside
        # this project even if a /load changed the global context since build time.
        if _project_ref is not None:
            from .tools import set_project_context as _spc
            _spc(_project_ref, _store_ref)

        if getattr(_project_ref, "mode", "auto") == "plan":
            return (
                "[BLOCKED] run_skill is not available while the project is in plan mode. "
                "Do not delegate to a worker or edit files yet. Gather any remaining context "
                "with safe read-only tools, then call create_plan with the proposed plan. "
                "Only after the user approves the plan may you execute it."
            )
            
        #print(f"\n{'-'*25} [DIAGNOSTIC: RUN_SKILL START] {'-'*25}")
        #print(f"[DIAGNOSTIC] Delegating to skill: '{skill_name}'")
        #print(f"[DIAGNOSTIC] Context passed:\n{context}")
        #print(f"{'-'*75}\n")

        # Delegating to yourself is not delegation: it would spawn a sub-agent
        # carrying this same orchestrator body, with a worker toolset and no
        # run_skill of its own. It is never what the caller meant.
        if skill_name == CHAT_ORCHESTRATOR_SKILL:
            targets = [
                s["name"] for s in active_skills(project_path)
                if s["name"] != CHAT_ORCHESTRATOR_SKILL
            ]
            return (
                f"[ERROR] '{CHAT_ORCHESTRATOR_SKILL}' is you, not a delegation target. "
                f"Do the work with your own tools, or delegate to one of: {targets}."
            )

        skill_dir = find_skill_dir(skill_name, project_path)
        if skill_dir is None:
            active = [
                s["name"] for s in active_skills(project_path)
                if s["name"] != CHAT_ORCHESTRATOR_SKILL
            ]
            # The closing advice has to match this orchestrator's real toolset
            # (PROJECT_DESIGN 2.6): under "direct" it can write and run commands
            # itself, so sending it to 'command-line' for that would be a
            # needless round-trip; under "delegate" that skill is its only route.
            from .tools import caller_has_terminal
            fallback = (
                "If you need to list, search, read, write, or run something directly, use your "
                "own direct tools (e.g. get_project_overview, search_code, read_file, "
                "write_file, run_command)."
                if caller_has_terminal() else
                "If you need to list, search, or read files directly, use your own direct tools "
                "(e.g. get_project_overview, search_code, read_file), and delegate anything that "
                "writes or runs to the 'command-line' skill."
            )
            return (
                f"[ERROR] Skill '{skill_name}' was not found / is not active. "
                f"You MUST NOT invent skill names. Your own tools (read_file, search_code, "
                f"get_project_overview, create_plan, web_search, ...) are tools you call "
                f"directly — they are never skill names. The only active skills you can "
                f"delegate to are: {active}. "
                f"{fallback}"
            )
        meta = parse_skill_md(skill_dir)
        if meta is None:
            return f"[ERROR] skill '{skill_name}' has no valid SKILL.md."


        # >> INHERITANCE LOGIC START <<
        extends_name = meta.get("extends")
        parent_dir = None
        if extends_name:
            active = [s["name"] for s in active_skills(project_path)]
            if extends_name not in active:
                return f"[ERROR] skill '{skill_name}' requires parent '{extends_name}' which is not active."
            parent_dir = find_skill_dir(extends_name, project_path)
            if parent_dir:
                parent_meta = parse_skill_md(parent_dir)
                if parent_meta:
                    meta["body"] = parent_meta["body"] + "\n\n" + meta["body"]
        # >> INHERITANCE LOGIC END <<

        model = resolve_skill_model(meta, project_model, project_worker)

        # Write the request to a fixed temp file so the sub-agent never has to
        # shell-quote a complex request (parens/quotes in the request would break
        # `run_command`'s shell=True). The model's command becomes paren-free:
        #   python <abs>/run_workflow.py --request-file <path>
        request_file = ""
        try:
            _staging = os.path.join(project_path, ".opalatex")
            os.makedirs(_staging, exist_ok=True)
            request_file = os.path.join(_staging, f"_skill_request_{skill_name}.txt")
            with open(request_file, "w", encoding="utf-8") as _rf:
                _rf.write(context)
        except Exception:
            request_file = ""

        # System prompt = SKILL.md body (Level 2) + working dir scope + exact paths.
        script_paths = []
        if parent_dir:
            parent_scripts_dir = os.path.join(parent_dir, "scripts")
            if os.path.isdir(parent_scripts_dir):
                script_paths.extend(
                    os.path.join(parent_scripts_dir, f) 
                    for f in sorted(os.listdir(parent_scripts_dir)) if f.endswith(".py")
                )
                
        scripts_dir = os.path.join(skill_dir, "scripts")
        if os.path.isdir(scripts_dir):
            script_paths.extend(
                os.path.join(scripts_dir, f)
                for f in sorted(os.listdir(scripts_dir)) if f.endswith(".py")
            )
            
        scripts_hint = ""
        if script_paths:
            listing = "\n".join(f'  "{p}"' for p in script_paths)
            scripts_hint = (
                f"\nScripts available in this skill (use the ABSOLUTE path with "
                f"run_command, keeping the double quotes shown below — paths may "
                f"contain spaces):\n{listing}\n"
                f"Example: run_command('python \"{script_paths[0]}\" sample \"<log_file_path>\"')\n"
            )
        request_hint = ""
        if request_file:
            request_hint = (
                f"\nThe user's request has been written to this file:\n  {request_file}\n"
                f"When a script needs the request, pass it as --request-file {request_file} "
                f"(do NOT type the request text into the command — use the file).\n"
            )
        worker_kwargs = get_agent_llm_kwargs("worker")

        model = get_agent_model("worker", model)

        # Resolved before the ollama_chat/ remap below, so the models_store lookup
        # (keyed on the stored "ollama/<name>" id) still matches.
        from .config import model_prompt_profile
        from .prompt_profiles import get_profile, DEFAULT_PROFILE
        worker_profile = model_prompt_profile(model)
        worker_profile_spec = get_profile(worker_profile)

        # Re-resolve the skill (and parent, if any) body for the profile now that
        # the worker's model is known. Frontmatter (model/extends) was already
        # read above from the canonical SKILL.md and is profile-independent.
        if worker_profile != DEFAULT_PROFILE:
            profiled = parse_skill_md(skill_dir, profile=worker_profile)
            if profiled and profiled.get("body"):
                body_for_profile = profiled["body"]
                if parent_dir:
                    profiled_parent = parse_skill_md(parent_dir, profile=worker_profile)
                    if profiled_parent and profiled_parent.get("body"):
                        body_for_profile = profiled_parent["body"] + "\n\n" + body_for_profile
                meta["body"] = body_for_profile

        from .config import resolve_model_route
        model = resolve_model_route(model, worker_kwargs)
        
        # Strip /v1 from the end because Ollama native providers expect the root URL
        if worker_kwargs.get("api_base"):
            if model.startswith("ollama/") or model.startswith("ollama_chat/"):
                if worker_kwargs["api_base"].endswith("/v1"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-3]
                elif worker_kwargs["api_base"].endswith("/v1/"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-4]

        native_tool_instruction = (
            _NATIVE_TOOL_CALL_REMINDER if _needs_native_tool_call_reminder(model) else ""
        )

        system = (
            worker_profile_spec["worker_intro"](skill_name)
            + worker_profile_spec["worker_tools_block"]()
            + "# Metadata: "
            + f"{meta['body']}\n\n"
            + f"You are executing the '{skill_name}' skill. "
            + f"Work inside the project directory: {project_path}\n"
            + f"The skill directory is: {skill_dir}\n"
            + f"{scripts_hint}"
            + f"{request_hint}"
            + f"IMPORTANT: To save any file content (HTML, JSON, code, Markdown, etc.) ALWAYS use the write_file tool. "
            + worker_profile_spec["worker_recommendations"]()
            + worker_profile_spec["achievements_instructions"]()
            + f"{native_tool_instruction}"
        )

        # Workers receive action tools only and return their final report as normal text.
        tools = [t for t in get_available_tools() if t.name != "send_message"]
        memgpt._current_worker_messages = []

        from .config import get_project_agent_params
        worker_agent_params = get_project_agent_params("worker")

        sub_agent = LLMAgentBlock(
            name=f"skill_{skill_name}",
            system_prompt=system,
            model=model,
            tools=tools,
            model_kwargs=worker_kwargs,
            use_shared_router=False,
            max_iterations=worker_agent_params.get("max_iterations", None),
            max_tool_calls=worker_agent_params.get("max_tool_calls", 40),
            loop_detection=worker_agent_params.get("loop_detection", True),
            loop_detection_limit=worker_agent_params.get("loop_detection_limit", 3),
        )
        from .litellm_compat import wrap_agent_litellm_compat
        from .token_usage import attach_usage_tracking
        wrap_agent_litellm_compat(sub_agent)
        attach_usage_tracking(sub_agent)

        from opalatex.agent_stdin import _record_turn_thought, print_event

        object.__setattr__(sub_agent, "model", model)
        object.__setattr__(sub_agent, "model_kargs", worker_kwargs)
        object.__setattr__(sub_agent, "model_kwargs", worker_kwargs)
        object.__setattr__(sub_agent, "use_shared_router", False)
        
        if worker_kwargs.get("stream", False):
            thought_chunks = []
            in_think_block = [False]
            think_buffer = [""]
            
            def _worker_on_thinking(chunk: str) -> None:
                if _record_turn_thought(chunk):
                    thought_chunks.append(chunk)
                    print_event("thought", {"content": chunk, "agent": f"worker:{skill_name}", "_thought_recorded": True})

            def _worker_on_chunk(chunk: str) -> None:
                think_buffer[0] += chunk
                while True:
                    if not in_think_block[0]:
                        if "<think>" in think_buffer[0]:
                            before, rest = think_buffer[0].split("<think>", 1)
                            if before:
                                print_event("stream_chunk", {"content": before, "agent": f"worker:{skill_name}"})
                            in_think_block[0] = True
                            think_buffer[0] = rest
                        else:
                            idx = think_buffer[0].rfind("<")
                            if idx != -1 and "<think>".startswith(think_buffer[0][idx:]):
                                before = think_buffer[0][:idx]
                                if before:
                                    print_event("stream_chunk", {"content": before, "agent": f"worker:{skill_name}"})
                                think_buffer[0] = think_buffer[0][idx:]
                            else:
                                if think_buffer[0]:
                                    print_event("stream_chunk", {"content": think_buffer[0], "agent": f"worker:{skill_name}"})
                                    think_buffer[0] = ""
                            break
                    else:
                        if "</think>" in think_buffer[0]:
                            inside, rest = think_buffer[0].split("</think>", 1)
                            if inside:
                                _worker_on_thinking(inside)
                            in_think_block[0] = False
                            think_buffer[0] = rest
                        else:
                            idx = think_buffer[0].rfind("<")
                            if idx != -1 and "</think>".startswith(think_buffer[0][idx:]):
                                before = think_buffer[0][:idx]
                                if before:
                                    _worker_on_thinking(before)
                                think_buffer[0] = think_buffer[0][idx:]
                            else:
                                if think_buffer[0]:
                                    _worker_on_thinking(think_buffer[0])
                                    think_buffer[0] = ""
                            break
                            
            if worker_kwargs.get("think", False):
                sub_agent.on_thinking = _worker_on_thinking
            sub_agent.on_chunk = _worker_on_chunk

        def _worker_on_iteration(_step: int, messages: list) -> None:
            last = messages[-1] if messages else {}
            content = last.get("content") or ""
            if content:
                print_event("reflection", {"content": str(content), "agent": f"worker:{skill_name}"})

        sub_agent.on_iteration = _worker_on_iteration

        os.environ.setdefault(
            "OPALATEX_ROOT",
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        # Automatically inject recent chat history so MemGPT doesn't have to waste tokens copying it
        recent_history = "\n".join([f"{m.get('role', 'unknown').upper()}: {m.get('content', '')}" for m in memgpt.internal_history[-10:] if m.get("role") in ("user", "assistant")])
        
        from .tools import TURN_ACHIEVEMENTS
        achievements_block = f"\n\n[TURN ACHIEVEMENTS MEMORY]\nThe orchestrator has noted the following accomplishments in this turn:\n{TURN_ACHIEVEMENTS}\n" if TURN_ACHIEVEMENTS else ""

        # Inject previous attempts for the same skill to keep a Markovian state
        if not hasattr(memgpt, "_skill_run_history"):
            memgpt._skill_run_history = []

        failed_delegations = _recent_failed_delegations(memgpt)
        if failed_delegations >= MAX_FAILED_DELEGATIONS:
            return (
                f"[SYSTEM ALERT] DELEGATION LOOP BREAKER: the last {failed_delegations} "
                "delegations, across every skill you tried, came back without a usable "
                "report. Switching skills or rewording the context is not fixing this. "
                "Stop delegating for this task: use your direct tools, ask the user what "
                "they need with ask_question, or return a concise normal-text blocker."
            )

        failed_attempts = _recent_failed_skill_attempts(memgpt, skill_name)
        if failed_attempts >= MAX_FAILED_SKILL_ATTEMPTS:
            return (
                f"[SYSTEM ALERT] WORKER LOOP BREAKER: The '{skill_name}' skill has failed "
                f"{failed_attempts} consecutive times without completing useful tool work. "
                "Do NOT call this same worker again for this task. Use your direct tools if "
                "available, reduce the task to a smaller verified action, or return a "
                "concise normal-text blocker explanation."
            )
            
        # Check for macro-loop
        for run in memgpt._skill_run_history:
            if run["skill"] == skill_name and run["context"] == context:
                return f"[SYSTEM ALERT] MACRO-LOOP DETECTED: You already delegated to '{skill_name}' with this EXACT context earlier in the session, and it failed or didn't resolve the issue. You MUST change your plan/context, use different instructions, or return a normal-text request for user input. DO NOT repeat the exact same delegation."
                
        previous_runs = ""
        attempt_count = 1
        for run in memgpt._skill_run_history:
            if run["skill"] == skill_name:
                previous_runs += (
                    f"--- Previous attempt {attempt_count} ---\n"
                    f"Context given: {str(run.get('context', ''))[:200]}...\n"
                    f"Result/Report: {_sanitize_skill_result_for_prompt(run.get('result', ''))}\n\n"
                )
                attempt_count += 1
                
        previous_runs_block = ""
        if previous_runs:
            previous_runs_block = f"\n[PREVIOUS ATTEMPTS HISTORY]\nYou have been called before in this session for the '{skill_name}' skill. Do NOT repeat failed approaches. Here are your previous attempts:\n{previous_runs}"

        prompt = f"RECENT CHAT HISTORY:\n{recent_history}{achievements_block}{previous_runs_block}\n\nMEMGPT CONTEXT/INSTRUCTIONS:\n{context}"
        worker_checkpoint_id = None
        worker_checkpoint_project_path = None
        try:
            from opalatex.config import get_git_strategy
            if get_git_strategy().lower() != "none":
                from opalatex.vcs import begin_agent_turn_checkpoint
                worker_checkpoint_project_path = project_path
                worker_checkpoint_id = await asyncio.to_thread(
                    begin_agent_turn_checkpoint,
                    worker_checkpoint_project_path,
                    f"worker:{skill_name}",
                )
        except Exception:
            worker_checkpoint_id = None
        from .tools import set_worker_context
        set_worker_context(True)
        try:
            out = await sub_agent.run(AgentInput(prompt=prompt))
            out_text = out.response if hasattr(out, "response") else str(out)
            tool_calls = getattr(out, "tool_calls_made", "?")
            #print(f"\n{'-'*25} [DIAGNOSTIC: WORKER FINISHED] {'-'*25}")
            #print(f"[DIAGNOSTIC] Worker '{skill_name}' tool calls made: {tool_calls}")
            #print(f"[DIAGNOSTIC] Worker output preview ({len(out_text)} chars):\n{out_text[:300]}...")
            #print(f"{'-'*75}\n")
        except Exception as e:
            out_text = f"[CRITICAL WORKER CRASH] A exceção não tratada interrompeu o worker: {str(e)}"
            tool_calls = "?"
            print(f"[DIAGNOSTIC WORKER CRASH]: {e}")

        finally:
            set_worker_context(False)
            if worker_checkpoint_id and worker_checkpoint_project_path:
                try:
                    from opalatex.vcs import finalize_agent_turn_checkpoint
                    await asyncio.to_thread(
                        finalize_agent_turn_checkpoint,
                        worker_checkpoint_project_path,
                        worker_checkpoint_id,
                        f"worker:{skill_name}",
                    )
                except Exception:
                    pass

        #if "<<NEED_INPUT>>" in out_text:
        #    parts = out_text.split("<<NEED_INPUT>>", 1)
        #    user_prompt = parts[1].strip() if len(parts) > 1 else "Please provide required input:"
        #    user_response = ask_human(user_prompt)
        #    out_text = out_text.replace("<<NEED_INPUT>>", f"[User provided: {user_response}]")

        # Return the summary of what the worker did to MemGPT
        worker_summary = "\n".join(getattr(memgpt, "_current_worker_messages", []))
        if not worker_summary.strip():
            worker_summary = out_text
            tool_call_count = _tool_calls_count(tool_calls)
            # Se o worker calou a boca e o texto for genérico, alertar o orquestrador que ele pode ter estourado o limite.
            if (
                tool_call_count == 0
                or not worker_summary.strip()
                or "max iterations reached" in worker_summary.lower()
            ):
                worker_summary = f"[AVISO: O worker terminou sem um resumo claro. Ele realizou {tool_calls} chamadas de ferramenta e o último texto gerado foi: {out_text}]"

        # A serialized tool call is not a report. Neutralise it here, before the text
        # reaches the orchestrator's context, the stored history, or the next worker
        # prompt — otherwise every consumer downstream learns the broken pattern.
        worker_summary, had_tool_call_payload = _strip_serialized_tool_calls(worker_summary)
        if not had_tool_call_payload and _is_broken_serialization(worker_summary):
            worker_summary = _BROKEN_SERIALIZATION_MARKER

        memgpt._last_worker_summary = worker_summary

        # Record this run
        memgpt._skill_run_history.append({
            "skill": skill_name,
            "context": context,
            "result": worker_summary
        })

        return f"[skill '{skill_name}' finished] Worker's summary/report:\n(Tools used by worker: {tool_calls})\n{worker_summary}"

    return run_skill


# ---------------------------------------------------------------------------
# Chat-orchestrator (the fixed MemGPT)
# ---------------------------------------------------------------------------

CHAT_HISTORY_SEED_LIMIT = 10
_SEEDED_ROLES = ("user", "assistant")


def restore_chat_orchestrator_state(memgpt: MemGPTAgentBlock, project, store) -> bool:
    """Restore the MemGPT working state saved for this chat.

    The orchestrator is rebuilt on every turn (the system prompt depends on mode,
    core memory and the active skills), so without this its context management —
    FIFO eviction and the recursive summary — would restart from scratch each time
    and only a raw slice of the chat would survive. Returns False when there is no
    saved state and the caller must seed from persisted history instead.
    """
    if store is None:
        return False
    chat_id = getattr(project, "current_chat_id", "") or ""
    if not chat_id:
        return False
    try:
        state = store.get_chat_agent_state(project.name, chat_id)
    except Exception:
        return False
    if not state or not state.get("internal_history"):
        return False
    memgpt.load_state(state)
    return True


def save_chat_orchestrator_state(memgpt: MemGPTAgentBlock, project, store) -> None:
    """Persist the MemGPT working state for this chat (best effort)."""
    if store is None or memgpt is None:
        return
    chat_id = getattr(project, "current_chat_id", "") or ""
    if not chat_id:
        return
    try:
        store.save_chat_agent_state(project.name, chat_id, memgpt.dump_state())
    except Exception:
        pass


def derive_context_usage_from_state(project, store) -> dict | None:
    """Count the window a chat's *restored* context will occupy, or ``None``.

    A conversation that last ran before the measurement was persisted has no
    provider number stored, and the front-end's character estimate over the
    visible bubbles is not a usable stand-in: it cannot see the system prompt,
    the recursive summary, the tool calls or the tool results, so it draws an
    almost full battery for an almost full window.

    What *is* available is the thing that actually fills the window: the working
    state the orchestrator will restore on the next turn. Rebuilding the same
    message list ``MemGPTAgentBlock`` sends (system prompt + recursive summary +
    internal history) and counting it with the model's own tokenizer is the same
    measurement the ``source: "local"`` count already reports before each call --
    not an estimate of a different quantity. It is still not the provider's
    number: the tool JSON schemas travel outside ``messages``, and the probe
    carries no tools so their descriptions are absent from the rendered MemGPT
    rules. Both omissions make it read slightly low, which the ``source`` field
    records so the panel can say where the number came from.

    Returns ``None`` when there is no saved state, which is the honest answer for
    a chat that never ran.
    """
    if store is None or project is None:
        return None
    chat_id = getattr(project, "current_chat_id", "") or ""
    if not chat_id:
        return None
    try:
        state = store.get_chat_agent_state(project.name, chat_id)
    except Exception:
        return None
    if not state or not state.get("internal_history"):
        return None

    project_model = getattr(project, "model", None) or ""
    model = get_agent_model("memgpt", get_agent_model("chat_agent", project_model))
    try:
        probe = MemGPTAgentBlock(
            name="chat_orchestrator",
            system_prompt=chat_orchestrator_system_prompt(project, store),
            model=model,
        )
        probe.load_state(state)
        tokens = probe.count_context_tokens()
    except Exception:
        return None
    if tokens <= 0:
        return None

    from .config import resolve_effective_num_ctx

    record = {
        "prompt_tokens": tokens,
        "completion_tokens": 0,
        "total_tokens": tokens,
        "source": "state",
    }
    try:
        window = int(resolve_effective_num_ctx("memgpt", project_model) or 0)
    except Exception:
        window = 0
    if window > 0:
        record["context_window"] = window
    return record


def seed_chat_orchestrator_history(memgpt: MemGPTAgentBlock, project) -> None:
    """Seed the working context from persisted history.

    Only the visible conversation is replayed. ``system``/``tool`` rows are never
    seeded: a mid-history system message breaks chat templates that require the
    system message to come first (PROJECT_DESIGN 2.7), and a stored tool row would
    arrive without its ``tool_call_id``. Message content is replayed verbatim —
    prefixing a timestamp would teach the model to echo that prefix in its own
    answers; the current date is already supplied by the system prompt.
    """
    history = getattr(project, "history", None) or []
    for msg in history[-CHAT_HISTORY_SEED_LIMIT:]:
        role = msg.get("role", "")
        if role not in _SEEDED_ROLES:
            continue
        content = msg.get("content", "")
        if role == "assistant" and str(content).lstrip().startswith("Agent Error:"):
            continue
        # Chats written before the empty-response fix can hold the runtime's own
        # marker as an assistant message. Replaying it teaches the model to answer
        # with it, which is how it got persisted in the first place.
        if role == "assistant" and is_empty_response_placeholder(content):
            continue
        memgpt.internal_history.append({"role": role, "content": content})


_NATIVE_TOOL_CALL_REMINDER = (
    "\nUse the provider-native tool-calling protocol for actions. Never write a "
    "tool call, its arguments, or an action request as text: not as JSON, not as "
    "Markdown, and not as <tool_call> or <function=...> markup."
)


# LiteLLM routes that only ever point at a server the user runs themselves.
_SELF_HOSTED_ROUTE_PREFIXES = (
    "hosted_vllm/",
    "vllm/",
    "openai_like/",
    "lm_studio/",
    "llamafile/",
)


def _needs_native_tool_call_reminder(model: str) -> bool:
    """True for self-hosted models, which need the protocol spelled out.

    Self-hosted models are the ones observed printing a tool call as text instead
    of issuing it. Ollama is where it happens most -- LiteLLM's OpenAI-compatible
    `ollama/` route is the one a model without thinking enabled lands on -- but the
    same failure appears on any model the user serves themselves, including the
    vLLM/NIM/LM Studio servers that are reached through the plain `openai/` route
    rather than a dedicated one. Gating on `ollama` alone left those uncovered.

    Both the orchestrator and skill workers use this: the reminder used to exist
    for workers only, which left the agent that talks to the user -- and whose
    serialized output goes straight to the screen -- as the only one without it.
    """
    model = str(model or "")
    if model.startswith("ollama") or model.startswith("ollama_chat") or "local" in model:
        return True
    if model.startswith(_SELF_HOSTED_ROUTE_PREFIXES):
        return True
    # `openai/<vendor>/<model>`: a genuine OpenAI model id carries no second path
    # segment, so an extra one means the OpenAI-compatible route is aimed at a
    # self-hosted server, which names its models after their source repository
    # (`openai/nvidia/Qwen3.6-35B-A3B-NVFP4`). Providers that legitimately use a
    # vendor path have their own prefix (`openrouter/`, `together_ai/`) and so are
    # untouched by this.
    return model.startswith("openai/") and "/" in model[len("openai/"):]


def _orchestrator_body_variant(skill_dir: str, profile: str, policy: str) -> str:
    """Pick which `SKILL.<variant>.md` body the orchestrator should load.

    Two independent axes select the body: the prompt *profile* (full/light) and
    the tool *policy* (direct/delegate). Candidates are tried most-specific
    first and must exist on disk, so shipping only some of the combinations is
    fine -- a missing `SKILL.light-delegate.md` falls back to
    `SKILL.delegate.md`, whose delegation rules matter more than the
    condensation. "full" is the canonical `SKILL.md` body and has no variant
    file of its own.
    """
    candidates = []
    if policy == "delegate":
        candidates.append(f"{profile}-delegate")
        candidates.append("delegate")
    candidates.append(profile)
    for name in candidates:
        if name == "full":
            return "full"
        if os.path.isfile(os.path.join(skill_dir, f"SKILL.{name}.md")):
            return name
    return "full"


def _chat_orchestrator_body(project_path: str, profile: str = "full", policy: str = "direct") -> str:
    """Return the chat-orchestrator SKILL.md body for *profile*/*policy*, or a fallback.

    *profile* and *policy* together select an optional `SKILL.<variant>.md` file
    next to the canonical `SKILL.md` (see `_orchestrator_body_variant` and
    `opalatex/prompt_profiles.py`). The fallback text below also doubles as the
    light profile's safety net when no `SKILL.light.md` is bundled yet.

    The delegate body is a replacement, not an appendix: the full body actively
    instructs the orchestrator to make small edits itself, so a delegate policy
    that merely appended an override would leave two contradictory rules in the
    same prompt.
    """
    skill_dir = find_skill_dir(CHAT_ORCHESTRATOR_SKILL, project_path)
    if skill_dir:
        variant = _orchestrator_body_variant(skill_dir, profile, policy)
        meta = parse_skill_md(skill_dir, profile=variant)
        if meta and meta["body"]:
            return meta["body"]
    if policy == "delegate":
        tools_rule = (
            "3. You have NO file-writing tools: write_file, write_content_pos and replace_content_range exist only inside skill workers. "
            "Use your read tools (search_code, read_file, read_content_pos, get_editor_state, get_project_overview, web_search, search_conversation_history) to locate the exact path and line range, then delegate every create/edit/rename/delete with run_skill. Never claim you edited a file yourself.\n"
        )
    else:
        tools_rule = (
            "3. You CAN and SHOULD use your tools (like search_code, read_file, read_content_pos, get_editor_state, write_file, replace_content_range, write_content_pos, web_search, get_project_overview, search_conversation_history) to investigate the user's request and handle precise text edits directly. "
            "write_file is the only tool that creates a new file; write_content_pos and replace_content_range require the file to already exist. "
            "You also run commands yourself with run_command (non-interactive), run_python_script, run_interactive_command (commands that prompt the user) and run_background_command (servers and other long-running processes): compile, build, test, rename and delete directly instead of delegating a single command to a worker.\n"
        )
    return (
        "Execute actions only through native tool calls.\n"
        "1. The runtime prepends today's date to this prompt. You MUST use web_search before answering, refusing, or delegating whenever (a) the request is time-sensitive (recent, latest, current, future-dated), (b) it names a concept, entity, acronym, paper or product you do not confidently recognize or that looks misspelled, or (c) it needs exact external data you cannot recall verbatim. You MUST NOT hallucinate dates or assume something did not happen without first searching the web.\n"
        "2. Return the final user-facing answer as normal text. JSON and Markdown in text are answers, never tool calls; use native tool calls only when executing an action.\n"
        + tools_rule +
        "4. If the user asks about something you do not know, search for it with web_search instead of guessing or replying that you have no information about it - a term missing from your training data is a reason to search, not a reason to refuse. If the user asks for something in the project, use get_project_overview to explore the project structure and read_file to read files.\n"
        "5. Whenever the user asks a question involving dates, time, recent events, latest events, sports, news, public figures, APIs, niche terminology, or potentially anachronistic information, you must search the web for updated information. Search public/external knowledge only: workspace questions go to the project read tools, and anything depending on the user's preference goes to ask_question.\n"
        "6. You can call run_skill to execute tasks. CRITICAL: You must ONLY delegate to skills explicitly listed under 'Available skills'. NEVER invent skill names like 'search_files', 'list_files', 'edit_file', or 'run_cmd'. "
        + (
            "To list, search or read directly, use get_project_overview, search_code, read_file or read_content_pos; every edit goes to a worker.\n"
            if policy == "delegate" else
            "If you need to list, search, read, make a precise line edit, or run a command directly, use get_project_overview, search_code, read_file, read_content_pos, write_file, replace_content_range, write_content_pos, or run_command.\n"
        ) +
        "7. AFTER the worker finishes, you will receive its summary. Use a <think> block to reflect on whether the task was fully resolved. If the worker changed files, verify the changed location with read_file/read_content_pos before reporting success. If it was NOT resolved or if the worker failed, you MAY call run_skill again with a revised plan unless a worker loop breaker tells you to stop. If the task IS complete, return a non-empty final result for the user.\n"
        "8. Every invocation of run_skill spawns a completely stateless, ephemeral sub-agent. The worker starts fresh with no memory of prior runs. You MUST NOT try to converse/coordinate with the worker across multiple turns or promise to provide details in a 'next step'. Provide all instructions and details in a single run_skill call.\n"
        "9. If you need to edit or write a large file (more than ~100-200 lines), do NOT instruct the worker to use write_file with the entire content, as LLM output limits will truncate the tool call. Instead, instruct it to use search_code to locate markers, replace_content_range for specific line ranges, write_content_pos only for insertion before a specific line, or a small Python search-and-replace script executed with run_command for bulk transformations.\n"
        "10. When handling, inspecting, comparing, or processing large structured data or log files (.jsonl, .csv, .tsv, .log), check your active 'Available skills' list for a specialized data/log skill and delegate to it. If no specialized skill is active, never attempt whole-file read_file; inspect small samples using read_content_pos or run a quick streaming Python script via command-line.\n"
        "NEVER assume something didn't happen without first searching the web using the web_search tool.\n"
        "CRITICAL: If you use a <think> block to plan your actions, continue until you either make a native tool call or provide a non-empty final text response.\n\n"
        "ACHIEVEMENTS MEMORY INSTRUCTION:\n"
        "You have the 'update_achievements_memory' tool. Use it FREQUENTLY to record your progress and milestones.\n"
        "Examples of achievements you MUST record:\n"
        "1. Discovered the location of an important file or snippet.\n"
        "2. Concluded a heartbeat/iteration (write a summary of what you did in that phase).\n"
        "3. Successfully read and understood a file's contents, or successfully wrote to a file.\n"
        "4. Discovered the root cause of an error or bug.\n"
        "You can output MULTIPLE tool calls in the same response to update achievements alongside your main action.\n"
    )


def chat_orchestrator_system_prompt(project, store=None) -> str:
    """Render the chat-orchestrator system prompt for a project.

    Extracted from ``build_chat_orchestrator`` so a caller that only needs the
    prompt -- measuring how full a restored context is, for instance -- does not
    have to build the whole agent. Deliberately free of side effects: unlike the
    builder, it never calls ``set_project_context``, which rescopes the global
    file/terminal tools and must not be triggered by a read-only request while
    another project's turn is running.
    """
    project_path = getattr(project, "project_path", "") or os.getcwd()
    project_model = getattr(project, "model", None) or ""
    project_worker = getattr(project, "worker_model", "") or project_model

    # Resolved early because the prompt profile (full/light) depends on the
    # orchestrator's model and, in turn, decides which skill-body variant and
    # mode-instructions rendering to use below.
    model = get_agent_model("memgpt", get_agent_model("chat_agent", project_model))
    from .config import model_prompt_profile, model_orchestrator_policy
    from .prompt_profiles import get_profile
    orchestrator_profile = model_prompt_profile(model)
    orchestrator_policy = model_orchestrator_policy(model)
    profile_spec = get_profile(orchestrator_profile)

    skills = active_skills(project_path)
    body = _chat_orchestrator_body(project_path, orchestrator_profile, orchestrator_policy)

    # A delegate orchestrator has no writing tools of its own, so without a skill
    # to send the work to it cannot change anything. The orchestrator's own entry
    # does not count -- it is not a delegation target -- while `command-line` is
    # mandatory and normally fills this role, so an empty result here means skill
    # discovery itself came up short (an unbundled install, say). Say so in the
    # prompt instead of quietly downgrading the configured policy to "direct":
    # the user picked delegate, and a silent substitution would hide the real
    # blocker behind writes that mysteriously start working again.
    delegate_targets = [s for s in skills if s.get("name") != CHAT_ORCHESTRATOR_SKILL]
    delegate_without_target = orchestrator_policy == "delegate" and not delegate_targets

    # The catalog lists what run_skill will actually accept, which is the same set:
    # the orchestrator cannot delegate to itself. Listing its own entry offered a
    # target that does nothing, and its SKILL.md carries no frontmatter, so the
    # entry rendered as a bare "- chat-orchestrator:" with an empty description --
    # a blank in a list of what is available, which models fill in by guessing
    # (one enumerated its own tools as skills). An empty catalog says so in words
    # rather than trailing off after the heading.
    metadata = level1_metadata(delegate_targets) or (
        "(none — no skill is available to delegate to; do the work with your own tools)"
    )

    project_name = getattr(project, "project_name", "") or getattr(project, "name", "(unknown)")
    project_desc = getattr(project, "description", "") or ""
    project_mode = getattr(project, "mode", "auto") or "auto"
    
    # Load the appropriate core memory based on sharing mode
    use_shared = getattr(project, "use_shared_memory", False)
    if use_shared:
        core_memory = getattr(project, "core_memory", "") or ""
    else:
        # Per-chat isolated core memory
        chat_id = getattr(project, "current_chat_id", "main")
        if store:
            core_memory = store.get_chat_core_memory(project.name, chat_id) or ""
        else:
            core_memory = ""

    mode_instructions = profile_spec["mode_instructions"](project_mode)

    project_block = (
        f"## Current Project\n"
        f"- **Name**: {project_name}\n"
        f"- **Path**: {project_path}\n"
        f"- **Model**: {project_model}\n"
        f"- **Worker Model**: {project_worker}\n"
        f"- **Mode**: {project_mode}\n"
        f"{mode_instructions}"
    )
    if project_desc:
        project_block += f"- **Description**: {project_desc}\n"
    if core_memory:
        project_block += (
            f"\n### Core Memory (persisted facts from previous conversations)\n"
            f"**IMPORTANT**: The entries below represent YOUR persistent memory — things you learned "
            f"from prior conversations with the user across different chat sessions. "
            f"Treat these as facts you already know. When the user asks if you remember something "
            f"or if you have talked before, refer to this section.\n\n"
            f"{core_memory}\n"
        )

    # The tutorial chat carries the OpalaTex usage guide in the system prompt rather
    # than in core memory or a seeded internal_history: per-chat core memory is only
    # read when the project does not share memory, and a seeded history would be
    # evicted and summarized away exactly when the user is still asking questions.
    # Scoped to that one chat, so no other conversation pays context for it.
    tutorial_block = ""
    if getattr(project, "current_chat_id", "") == tutorial_chat_id(project.name):
        try:
            from .tutorial import tutorial_system_block
            from .ui_settings import load_ui_settings
            tutorial_block = "\n" + tutorial_system_block(
                load_ui_settings().get("lang", "pt")
            )
        except Exception:
            tutorial_block = ""

    blocked_block = ""
    if delegate_without_target:
        blocked_block = (
            "\n## Writing is currently impossible\n"
            "You are configured to delegate every file change, but this project has no "
            "active skill to delegate to, so nothing can be written or edited right now. "
            "Do not attempt a write tool — you have none. If the user asks for a file "
            "change, say plainly that no skill is active and ask them to enable one with "
            "`/addskill <name>` (`/skills` lists what is available). Reading, searching "
            "and answering questions still work normally.\n"
        )

    # The orchestrator's own model decides this, not the worker's: an Ollama-served
    # orchestrator that prints a tool call as text sends that JSON straight to the
    # user, since nothing downstream can turn it back into an action.
    native_tool_block = (
        _NATIVE_TOOL_CALL_REMINDER + "\n"
        if _needs_native_tool_call_reminder(model) else ""
    )

    system_prompt = (
        f"{_current_date_instruction()}\n\n"
        f"{body}\n\n"
        f"{project_block}\n"
        f"## Available skills (call run_skill with the skill name)\n{metadata}\n"
        f"{blocked_block}"
        f"{native_tool_block}"
        f"{tutorial_block}"
    )
    return system_prompt


def build_chat_orchestrator(project, store=None) -> MemGPTAgentBlock:
    """Build the fixed MemGPT chat-orchestrator for a project.

    The system prompt = chat-orchestrator SKILL.md body + Level-1 metadata of the
    active skills. Tools = run_skill + the memory tools. Uses the framework
    MemGPTAgentBlock (classic memory) per docs/specs/04 §1.
    """
    from .tools import (
        read_core_memory, append_core_memory, search_conversation_history,
        set_project_context,
    )

    project_path = getattr(project, "project_path", "") or os.getcwd()
    # An unconfigured project keeps an empty model here. The orchestrator is still
    # built (so the project can be opened and configured), but handle_run refuses to
    # run it instead of silently substituting DEFAULT_MODEL for the user's choice.
    project_model = getattr(project, "model", None) or ""
    project_worker = getattr(project, "worker_model", "") or project_model

    # Scope all file/terminal tools to the project directory. Without this,
    # get_project_path() falls back to the cwd (the OpalaTex repo root) and the
    # sub-agent's write_file/run_command would act outside the project.
    set_project_context(project, store)

    system_prompt = chat_orchestrator_system_prompt(project, store)
    # Resolved again here (cheap and pure) because the LiteLLM kwargs and the
    # thinking route below need the model, not just the prompt.
    model = get_agent_model("memgpt", get_agent_model("chat_agent", project_model))

    _llm_kwargs = get_agent_llm_kwargs("memgpt")
    
    model_params = getattr(project, "model_params", {}) or {}
    enable_achievements = model_params.get("enable_achievements", True)
    
    from .agent_stdin import wrap_tool
    from .tools import create_plan, ask_question

    # Read/answer tools the orchestrator keeps under every policy. The memory
    # tools write, but only to core memory -- never to the user's files -- so
    # they are not part of what "delegate" withholds.
    orchestrator_tools = [
        wrap_tool(ask_question),
        wrap_tool(read_core_memory),
        wrap_tool(read_file),
        wrap_tool(read_content_pos),
        wrap_tool(get_editor_state),
        wrap_tool(search_code),
        wrap_tool(get_project_overview),
        wrap_tool(append_core_memory),
        wrap_tool(search_conversation_history),
        wrap_tool(web_search),
        wrap_tool(analyze_image),
        wrap_tool(create_plan),
    ]

    # Enforced by composing the tool list per role, not by the mode gate in
    # `opalatex_tool`: that gate reads the shared project mode and wraps the very
    # same function objects the worker calls, so blocking writes there would
    # disarm the worker too and leave the delegate policy with no way to write at
    # all. Withholding the tools here scopes the restriction to this agent.
    #
    # What "direct" grants is the worker's own action toolset, taken from the
    # single list in `tools.get_workspace_action_tools()` rather than restated
    # here: an orchestrator authorized to rewrite `main.tex` but not to run
    # `pdflatex` on it holds half an authority and has to delegate mid-task
    # anyway, which is the round-trip the policy exists to avoid. Composing both
    # roles from one list also keeps them from drifting apart as tools are added.
    #
    # The command-execution tools are `is_safe=False`, so plan mode still blocks
    # them and edit mode still asks the user -- the gate is role-independent, and
    # granting the tools here does not weaken it.
    from .config import model_orchestrator_policy
    orchestrator_policy = model_orchestrator_policy(model)
    # Recovery advice in tools.py branches on whether the caller can run commands
    # (PROJECT_DESIGN 2.6), so it is recorded from the same policy decision that
    # composes the tool list and can never contradict it.
    from .tools import set_orchestrator_terminal_access
    set_orchestrator_terminal_access(orchestrator_policy != "delegate")
    if orchestrator_policy != "delegate":
        from .tools import get_workspace_action_tools
        orchestrator_tools.extend(
            wrap_tool(tool) for tool in get_workspace_action_tools()
        )
    if enable_achievements:
        from .tools import update_achievements_memory
        orchestrator_tools.append(wrap_tool(update_achievements_memory))

    from .config import resolve_model_route, resolve_effective_num_ctx
    model = resolve_model_route(model, _llm_kwargs)


    # Strip /v1 from the end because Ollama native providers expect the root URL
    if _llm_kwargs.get("api_base"):
        if model.startswith("ollama/") or model.startswith("ollama_chat/"):
            if _llm_kwargs["api_base"].endswith("/v1"):
                _llm_kwargs["api_base"] = _llm_kwargs["api_base"][:-3]
            elif _llm_kwargs["api_base"].endswith("/v1/"):
                _llm_kwargs["api_base"] = _llm_kwargs["api_base"][:-4]
                
    _agent_params = get_project_agent_params()

    memgpt = MemGPTAgentBlock(
        name="chat_orchestrator",
        system_prompt=system_prompt,
        model=model,
        tools=orchestrator_tools,
        model_kwargs=_llm_kwargs,
        max_heartbeats=_agent_params.get("max_heartbeats", get_agent_max_heartbeats("memgpt", 20)),
        # Not _llm_kwargs.get("num_ctx", ...): that dict is the *sanitized*
        # LiteLLM request, and sanitize_litellm_kwargs_for_model deliberately
        # strips num_ctx for non-Ollama providers before it reaches here (cloud
        # endpoints reject the param). resolve_effective_num_ctx computes the
        # true effective window independent of what is actually sent over the
        # wire, so a cloud model's catalog num_ctx is not silently lost.
        max_context_tokens=_agent_params.get("max_context_tokens", resolve_effective_num_ctx("memgpt")),
        # Start evicting before the window is completely full: at 1.0 there is no
        # headroom left for the model's own answer once the request is assembled.
        eviction_threshold=_agent_params.get("eviction_threshold", 0.85),
        memory_pressure_threshold=_agent_params.get("memory_pressure_threshold", 0.7),
        debug=_agent_params.get("debug", False),
        use_shared_router=_agent_params.get("use_shared_router", True),
        response_mode=_agent_params.get("response_mode", get_agent_response_mode("memgpt")),
        loop_detection=_agent_params.get("loop_detection", model_params.get("loop_detection", True)),
        loop_detection_limit=_agent_params.get(
            "loop_detection_limit", model_params.get("loop_detection_limit", 3)
        ),
        # Opt-in: when the model writes its whole answer in the reasoning channel and
        # leaves the visible one empty, publish the reasoning instead of spending a
        # heartbeat asking for it again (PROJECT_DESIGN 2.7).
        empty_response_reasoning_fallback=bool(
            _agent_params.get(
                "empty_response_reasoning_fallback",
                model_params.get("empty_response_reasoning_fallback", False),
            )
        ),
    )
    from .litellm_compat import wrap_agent_litellm_compat
    from .token_usage import attach_usage_tracking
    wrap_agent_litellm_compat(memgpt)
    # Report real context occupancy for the CLI path too, not only for runs that
    # go through agent_stdin.
    attach_usage_tracking(memgpt)

    from opalatex.agent_stdin import _record_turn_thought, print_event
    
    if _llm_kwargs.get("stream", False):
        orchestrator_thought_chunks = []
        in_think_block_orch = [False]
        think_buffer_orch = [""]

        def _orch_on_thinking(chunk: str) -> None:
            if _record_turn_thought(chunk):
                orchestrator_thought_chunks.append(chunk)
                print_event("thought", {"content": chunk, "agent": "orchestrator", "_thought_recorded": True})

        def _orch_on_chunk(chunk: str) -> None:
            think_buffer_orch[0] += chunk
            while True:
                if not in_think_block_orch[0]:
                    if "<think>" in think_buffer_orch[0]:
                        before, rest = think_buffer_orch[0].split("<think>", 1)
                        if before:
                            print_event("stream_chunk", {"content": before, "agent": "orchestrator"})
                        in_think_block_orch[0] = True
                        think_buffer_orch[0] = rest
                    else:
                        idx = think_buffer_orch[0].rfind("<")
                        if idx != -1 and "<think>".startswith(think_buffer_orch[0][idx:]):
                            before = think_buffer_orch[0][:idx]
                            if before:
                                print_event("stream_chunk", {"content": before, "agent": "orchestrator"})
                            think_buffer_orch[0] = think_buffer_orch[0][idx:]
                        else:
                            if think_buffer_orch[0]:
                                print_event("stream_chunk", {"content": think_buffer_orch[0], "agent": "orchestrator"})
                                think_buffer_orch[0] = ""
                        break
                else:
                    if "</think>" in think_buffer_orch[0]:
                        inside, rest = think_buffer_orch[0].split("</think>", 1)
                        if inside:
                            _orch_on_thinking(inside)
                        in_think_block_orch[0] = False
                        think_buffer_orch[0] = rest
                    else:
                        idx = think_buffer_orch[0].rfind("<")
                        if idx != -1 and "</think>".startswith(think_buffer_orch[0][idx:]):
                            before = think_buffer_orch[0][:idx]
                            if before:
                                _orch_on_thinking(before)
                            think_buffer_orch[0] = think_buffer_orch[0][idx:]
                        else:
                            if think_buffer_orch[0]:
                                _orch_on_thinking(think_buffer_orch[0])
                                think_buffer_orch[0] = ""
                        break
                        
        if _llm_kwargs.get("think", False):
            memgpt.on_thinking = _orch_on_thinking
        memgpt.on_chunk = _orch_on_chunk

    if not restore_chat_orchestrator_state(memgpt, project, store):
        seed_chat_orchestrator_history(memgpt, project)

    # run_skill is bound to this MemGPT instance (interceptor needs its history)
    # and to the project (so it can re-scope file tools on each call).
    run_skill = build_run_skill_tool(
        memgpt, 
        project.project_path,
        project_model=project.model,
        project_worker=project.worker_model,
        _project_ref=project,
        _store_ref=store,
    )
    memgpt.tools = list(memgpt.tools) + [wrap_tool(run_skill)]

    return memgpt
