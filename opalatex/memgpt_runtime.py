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
import os
from typing import Any

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
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
    create_docx_file,
    create_pptx_file,
    read_content_pos,
    replace_content_range,
    write_content_pos,
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

CHAT_ORCHESTRATOR_SKILL = "chat-orchestrator"
MAX_FAILED_SKILL_ATTEMPTS = 2


def _is_failed_worker_result(result: Any) -> bool:
    text = str(result or "")
    lowered = text.lower()
    return (
        "[critical worker crash]" in lowered
        or "[aviso: o worker terminou sem um resumo claro" in lowered
        or "tools used by worker: 0" in lowered
        or "0 chamadas de ferramenta" in lowered
        or "tool-call json parsing failed" in lowered
    )


def _recent_failed_skill_attempts(memgpt: MemGPTAgentBlock, skill_name: str) -> int:
    attempts = 0
    for run in reversed(getattr(memgpt, "_skill_run_history", [])):
        if run.get("skill") != skill_name:
            break
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
        f"Today is {date_text}. For any user request involving recent events, "
        "current facts, latest/last occurrences, schedules, public facts that may "
        "have changed, or dates that could be after your training data, you MUST "
        "use the web_search tool before answering, refusing, or delegating. Never "
        "claim that a current or future-dated event did not happen without first "
        "checking the web."
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

    from opalatex.ui_settings import load_ui_settings
    __is_cloud = load_ui_settings().get("ai_provider") == "cloud"

    @as_tool(
        name="run_skill",
        description=(
            "Delegate the current task to a registered skill. Pass the skill name (exactly matching "
            "one of the active skills shown to you under 'Available skills') and a context string with "
            "relevant facts or instructions. "
            "CRITICAL: You must ONLY call run_skill with a skill name that is explicitly listed "
            "in the 'Available skills' section of your system prompt. Do NOT invent skill names. "
            "If the task requires terminal commands, directory manipulation, or complex file editing, "
            "delegate to the 'command-line' skill. If you need to locate text in project files, "
            "use your direct search_code tool. Do NOT try to call non-existent skills like "
            "'search_files', 'list_files', or 'edit_file'."
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
            
        skill_dir = find_skill_dir(skill_name, project_path)
        if skill_dir is None:
            active = [s["name"] for s in active_skills(project_path)]
            return (
                f"[ERROR] Skill '{skill_name}' was not found / is not active. "
                f"You MUST NOT invent skill names. The only active skills you can delegate to are: {active}. "
                "If you need to list, search, read, or write files directly, use your own direct tools "
                "(e.g. get_project_overview, search_code, read_file) "
                "or delegate to the 'command-line' skill."
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
            listing = "\n".join(f"  {p}" for p in script_paths)
            scripts_hint = (
                f"\nScripts available in this skill (use the ABSOLUTE path with "
                f"run_command):\n{listing}\n"
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
        
        from .config import resolve_model_for_thinking
        model = resolve_model_for_thinking(model, worker_kwargs)
        
        # Strip /v1 from the end because Ollama native providers expect the root URL
        if worker_kwargs.get("api_base"):
            if model.startswith("ollama/") or model.startswith("ollama_chat/"):
                if worker_kwargs["api_base"].endswith("/v1"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-3]
                elif worker_kwargs["api_base"].endswith("/v1/"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-4]

        is_local_ollama = (
            model.startswith("ollama")
            or model.startswith("ollama_chat")
            or "local" in model
        )
        native_tool_instruction = ""
        if is_local_ollama:
            native_tool_instruction = (
                "\nUse the provider-native tool-calling protocol for actions. Never write a "
                "tool call, its arguments, or an action request as JSON or Markdown text."
            )

        system = (
            "#ROLE: "
            "You are a problem-solving agent. You must use your available tools and skills "
            "to fulfill the user's request provided in your context. "
            "\n--- WORKER RESPONSE CONTRACT ---\n"
            "Use native provider tool calls only when an action is required. If the task requires reading, editing, or executing something, make the appropriate native tool call before reporting completion.\n"
            "Never serialize a tool call as JSON or Markdown text. If no action is needed or the work is complete, return a concise normal-text report.\n"
            "--------------------------------------------\n\n"
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
            "# Metadata: "
            f"{meta['body']}\n\n"
            f"You are executing the '{skill_name}' skill. "
            f"Work inside the project directory: {project_path}\n"
            f"The skill directory is: {skill_dir}\n"
            f"{scripts_hint}"
            f"{request_hint}"
            f"IMPORTANT: To save any file content (HTML, JSON, code, Markdown, etc.) ALWAYS use the write_file tool. "
            f"RECOMMENDATION FOR EXECUTION AND TERMINATION:\n"
            f"- If MEMGPT CONTEXT/INSTRUCTIONS contains an explicit command or script to execute, use run_command as the first native tool call.\n"
            f"- If MEMGPT CONTEXT/INSTRUCTIONS already identifies the target file, line range, or edit, do not call get_project_overview first.\n"
            f"- For large .tex, .log, or source files, never call read_file just to find a section or marker; use search_code to locate the marker, then read_content_pos for the returned line range.\n"
            f"- Complete required actions through native tool calls, then return a concise normal-text report.\n"
            f"- Do not claim that a modification succeeded until the relevant tool has succeeded.\n"
            f"CRITICAL THINKING RULE: Keep your internal reasoning extremely brief and concise. DO NOT enter infinite brainstorming loops (e.g. repeatedly asking yourself 'Should I do X? Yes/No. Wait!'). Formulate a quick plan and IMMEDIATELY execute a tool or return.\n"
            f"ACHIEVEMENTS MEMORY INSTRUCTION:\n"
            f"You have access to the 'update_achievements_memory' tool. Use it FREQUENTLY to record your progress and milestones.\n"
            f"Examples of achievements you MUST record:\n"
            f"1. Discovered the location of an important file or snippet.\n"
            f"2. Concluded a heartbeat/iteration (write a summary of what you did in that phase).\n"
            f"3. Successfully read and understood a file's contents, or successfully wrote to a file.\n"
            f"4. Discovered the root cause of an error or bug.\n"
            f"You can output MULTIPLE tool calls in the same response to update achievements alongside your main action.\n"
            f"{native_tool_instruction}"
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
        wrap_agent_litellm_compat(sub_agent)

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
                worker_checkpoint_id = begin_agent_turn_checkpoint(
                    worker_checkpoint_project_path,
                    f"worker:{skill_name}",
                )
        except Exception:
            worker_checkpoint_id = None
        try:
            out = await sub_agent.run(AgentInput(prompt=prompt))
            out_text = out.response if hasattr(out, "response") else str(out)
            tool_calls = getattr(out, "tool_calls_made", "?")
        except Exception as e:
            out_text = f"[CRITICAL WORKER CRASH] A exceção não tratada interrompeu o worker: {str(e)}"
            tool_calls = "?"

        finally:
            if worker_checkpoint_id and worker_checkpoint_project_path:
                try:
                    from opalatex.vcs import finalize_agent_turn_checkpoint
                    finalize_agent_turn_checkpoint(
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

def _chat_orchestrator_body(project_path: str) -> str:
    """Return the chat-orchestrator SKILL.md body, or a minimal fallback."""
    skill_dir = find_skill_dir(CHAT_ORCHESTRATOR_SKILL, project_path)
    if skill_dir:
        meta = parse_skill_md(skill_dir)
        if meta and meta["body"]:
            return meta["body"]
    return (
        "You are the OpalaTex chat-orchestrator. Execute actions only through native tool calls.\n"
        "1. The runtime prepends today's date to this prompt. If the user asks for recent, latest, current, future-dated, or otherwise time-sensitive information, you MUST use web_search before answering, refusing, or delegating. You MUST NOT hallucinate dates or assume something did not happen without first searching the web.\n" 
        "2. Return the final user-facing answer as normal text. JSON and Markdown in text are answers, never tool calls; use native tool calls only when executing an action.\n"
        "3. You CAN and SHOULD use your tools (like search_code, read_file, read_content_pos, replace_content_range, write_content_pos, web_search, get_project_overview, search_conversation_history) to investigate the user's request and handle precise text edits directly.\n"
        "4. If the user asks for something that you don't know, you can use web_search to find relevant information. If the user asks for something in the project, you can use get_project_overview to explore the project structure and read_file to read files.\n"
        "5. Whenever the user asks a question involving dates, time, recent events, latest events, sports, news, public figures, APIs, or potentially anachronistic information, you must search the web for updated information.\n"
        "6. You can call run_skill to execute tasks. CRITICAL: You must ONLY delegate to skills explicitly listed under 'Available skills'. NEVER invent skill names like 'search_files', 'list_files', 'edit_file', or 'run_cmd'. If you need to list, search, read, or make a precise line edit directly, use get_project_overview, search_code, read_file, read_content_pos, replace_content_range, or write_content_pos.\n"
        "7. AFTER the worker finishes, you will receive its summary. Use a <think> block to reflect on whether the task was fully resolved. If the worker changed files, verify the changed location with read_file/read_content_pos before reporting success. If it was NOT resolved or if the worker failed, you MAY call run_skill again with a revised plan unless a worker loop breaker tells you to stop. If the task IS complete, return a non-empty final result for the user.\n"
        "8. Every invocation of run_skill spawns a completely stateless, ephemeral sub-agent. The worker starts fresh with no memory of prior runs. You MUST NOT try to converse/coordinate with the worker across multiple turns or promise to provide details in a 'next step'. Provide all instructions and details in a single run_skill call.\n"
        "9. If you need to edit or write a large file (more than ~100-200 lines), do NOT instruct the worker to use write_file with the entire content, as LLM output limits will truncate the tool call. Instead, instruct it to use search_code to locate markers, replace_content_range for specific line ranges, write_content_pos only for insertion before a specific line, or a small Python search-and-replace script executed with run_command for bulk transformations.\n"
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


def build_chat_orchestrator(project, store=None) -> MemGPTAgentBlock:
    """Build the fixed MemGPT chat-orchestrator for a project.

    The system prompt = chat-orchestrator SKILL.md body + Level-1 metadata of the
    active skills. Tools = run_skill + the memory tools. Uses the framework
    MemGPTAgentBlock (classic memory) per docs/specs/04 §1.
    """
    from opalatex.ui_settings import load_ui_settings
    __is_cloud = load_ui_settings().get("ai_provider") == "cloud"
    from .tools import (
        read_core_memory, append_core_memory, search_conversation_history,
        set_project_context,
    )

    project_path = getattr(project, "project_path", "") or os.getcwd()
    project_model = getattr(project, "model", None) or DEFAULT_MODEL
    project_worker = getattr(project, "worker_model", "") or project_model or DEFAULT_MODEL

    # Scope all file/terminal tools to the project directory. Without this,
    # get_project_path() falls back to the cwd (the OpalaTex repo root) and the
    # sub-agent's write_file/run_command would act outside the project.
    set_project_context(project, store)

    skills = active_skills(project_path)
    metadata = level1_metadata(skills)
    body = _chat_orchestrator_body(project_path)

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

    mode_instructions = ""
    if project_mode == "plan":
        mode_instructions = (
            "\n🚨 **SYSTEM ALERT: You are currently in 'plan' mode.**\n"
            "INSTRUCTIONS: Your goal is to gather context and propose a plan. "
            "You MUST NOT execute modifying tools (like editing files or running terminal commands). "
            "You MUST NOT call run_skill in plan mode because workers can modify files. "
            "Once you have enough context, you MUST use the `create_plan` tool to present your plan for user approval.\n"
        )
    elif project_mode == "edit":
        mode_instructions = (
            "\n🚨 **SYSTEM ALERT: You are currently in 'edit' mode.**\n"
            "INSTRUCTIONS: You should focus on editing files and answering questions. "
            "If an action requires terminal execution or long-running tasks, ask the user for permission first.\n"
        )
    elif project_mode == "auto":
        mode_instructions = (
            "\n🚨 **SYSTEM ALERT: You are currently in 'auto' mode.**\n"
            "INSTRUCTIONS: You have full autonomy to execute tools, run commands, and complete tasks without asking for permission on every step.\n"
        )

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

    system_prompt = (
        f"{_current_date_instruction()}\n\n"
        f"{body}\n\n"
        f"{project_block}\n"
        f"## Available skills (call run_skill with the skill name)\n{metadata}\n"
    )

    model = get_agent_model("memgpt", get_agent_model("chat_agent", project_model))
    _llm_kwargs = get_agent_llm_kwargs("memgpt")
    
    model_params = getattr(project, "model_params", {}) or {}
    enable_achievements = model_params.get("enable_achievements", True)
    
    from .agent_stdin import wrap_tool
    from .tools import create_plan

    orchestrator_tools = [
        wrap_tool(read_core_memory), 
        wrap_tool(read_file), 
        wrap_tool(read_content_pos),
        wrap_tool(write_content_pos),
        wrap_tool(replace_content_range),
        wrap_tool(search_code),
        wrap_tool(get_project_overview), 
        wrap_tool(append_core_memory), 
        wrap_tool(search_conversation_history), 
        wrap_tool(web_search),
        wrap_tool(analyze_image),
        wrap_tool(create_docx_file),
        wrap_tool(create_pptx_file),
        wrap_tool(create_plan)
    ]
    if enable_achievements:
        from .tools import update_achievements_memory
        orchestrator_tools.append(wrap_tool(update_achievements_memory))

    from .config import resolve_model_for_thinking
    model = resolve_model_for_thinking(model, _llm_kwargs)
    
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
        max_context_tokens=_agent_params.get("max_context_tokens", model_params.get("num_ctx", _llm_kwargs.get("num_ctx", 8192))),
        eviction_threshold=_agent_params.get("eviction_threshold", 1.0),
        memory_pressure_threshold=_agent_params.get("memory_pressure_threshold", 0.7),
        debug=_agent_params.get("debug", False),
        use_shared_router=_agent_params.get("use_shared_router", True),
        response_mode=_agent_params.get("response_mode", get_agent_response_mode("memgpt")),
    )
    from .litellm_compat import wrap_agent_litellm_compat
    wrap_agent_litellm_compat(memgpt)

    # Seed the working context from persisted history so the conversation restores
    # across restarts (the old chat_agent did this; the MemGPT starts empty).
    _VALID_ROLES = {"user", "assistant", "system", "tool"}
    history = getattr(project, "history", None) or []
    for msg in history[-10:]:
        role = msg.get("role", "assistant")
        if role not in _VALID_ROLES:
            role = "assistant"
        content = msg.get("content", "")
        if role == "assistant" and str(content).lstrip().startswith("Agent Error:"):
            continue
        if msg.get("timestamp"):
            content = f"[{msg['timestamp']}] {content}"
        memgpt.internal_history.append({"role": role, "content": content})

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
