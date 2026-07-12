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
from opalatex.tools import run_command
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
    web_search,
    analyze_image,
    create_docx_file,
    create_pptx_file,
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

_PROVIDER_ALIASES = {"ollama_chat": "ollama"}


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


def _apply_modelconfig_provider(model: str, project) -> str:
    """If the project has a modelconfig yaml for *model* that declares a
    ``provider`` field, return ``<provider>/<model_name>`` instead of *model*.

    This ensures that e.g. ``ollama/gpt-oss:latest`` is transparently remapped
    to ``ollama_chat/gpt-oss:latest`` when the yaml specifies
    ``provider: ollama_chat`` — without requiring the user to manually save the
    project after loading the modelconfig.
    """
    if not model or "/" not in model:
        return model
    raw_provider, model_name = model.split("/", 1)
    provider_dir = _PROVIDER_ALIASES.get(raw_provider, raw_provider)
    project_path = getattr(project, "project_path", None)
    if not project_path:
        return model
    import yaml as _yaml
    yaml_name = model_name.replace(":", "__") + ".yaml"
    config_path = os.path.join(project_path, ".opalatex", "modelsconfig", provider_dir, yaml_name)
    if not os.path.isfile(config_path):
        return model
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = _yaml.safe_load(f) or {}
        new_provider = cfg.get("provider")
        if new_provider and new_provider != raw_provider:
            return f"{new_provider}/{model_name}"
    except Exception:
        pass
    return model


# ---------------------------------------------------------------------------
# Model resolution for a skill's sub-agent
# ---------------------------------------------------------------------------

def resolve_skill_model(skill_meta: dict, project_model: str | None,
                        project_worker: str | None = None) -> str:
    """Resolve the model for a skill's sub-agent from the SKILL.md `model` field.

    "default" → the project's main model; "worker" (or "alternative") → the project's worker
    model (or the project's main model when the worker model is empty).
    """
    raw = (skill_meta.get("model") or "").strip()
    if not raw:
        return project_model or DEFAULT_MODEL
    if raw == "default":
        return project_model or DEFAULT_MODEL
    if raw in ("alternative", "worker"):
        return project_worker or project_model or DEFAULT_MODEL
    return raw


# ---------------------------------------------------------------------------
# Interceptor: sub-agent send_message → user + MemGPT memory
# ---------------------------------------------------------------------------

def make_intercepted_send_message(memgpt: MemGPTAgentBlock, skill_name: str):
    """Return a ``send_message`` tool whose calls are logged and buffered.

    The wrapper is deterministic: each call records the worker report so the
    orchestrator can summarize it in its own final ``send_message``.
    """

    @as_tool(
        name="send_message",
        description=(
            "Send a message to the user. Call this to report progress or the final "
            "result. Provide a clear, past-tense summary when the task is complete.\n"
            "CRITICAL WARNING: This tool ONLY sends text to the user. It DOES NOT "
            "modify any files or execute any code. Do NOT use this tool to pretend "
            "you have applied a fix. If you decided to write or modify code, you MUST "
            "use the file modification tools (e.g. write_file) or terminal tools "
            "BEFORE calling send_message. NEVER put the code to be changed inside a "
            "send_message call if your goal was to apply it. Only report success AFTER the tools have returned success."
        ),
    )
    def send_message(message: str) -> str:
        # 1. Record the worker message before emitting any diagnostic event.
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
            print(json.dumps({
                "event": "info",
                "message": info_message,
            }), flush=True)

        # 2. Show to the terminal for diagnostics.
        T.console.print(f"\n[bold green]OpalaTex ({skill_name}):[/bold green] {message}\n")
        return "[DONE] message recorded for orchestrator"

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
    that body as system prompt, the workflow tools, and an intercepted send_message,
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
            "delegate to the 'command-line' skill. Do NOT try to call non-existent skills like "
            "'search_files', 'list_files', or 'edit_file'."
        ),
    )
    async def run_skill(skill_name: str, context: str) -> str:
        # Re-assert project scope so the sub-agent's file/terminal tools act inside
        # this project even if a /load changed the global context since build time.
        if _project_ref is not None:
            from .tools import set_project_context as _spc
            _spc(_project_ref, _store_ref)
            
        # import json
        # print(json.dumps({
        #     "event": "info",
        #     "data": {"message": f"Iniciando sub-agente '{skill_name}' em background..."}
        # }), flush=True)
        
        skill_dir = find_skill_dir(skill_name, project_path)
        if skill_dir is None:
            active = [s["name"] for s in active_skills(project_path)]
            return (
                f"[ERROR] Skill '{skill_name}' was not found / is not active. "
                f"You MUST NOT invent skill names. The only active skills you can delegate to are: {active}. "
                "If you need to list, read, or write files directly, use your own direct tools (e.g. get_project_overview, read_file) "
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
        
        from .config import resolve_model_for_thinking
        model = resolve_model_for_thinking(model, worker_kwargs)
        
        model = get_agent_model("worker", model)
        
        # Strip /v1 from the end because Ollama native providers expect the root URL
        if worker_kwargs.get("api_base"):
            if model.startswith("ollama/") or model.startswith("ollama_chat/"):
                if worker_kwargs["api_base"].endswith("/v1"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-3]
                elif worker_kwargs["api_base"].endswith("/v1/"):
                    worker_kwargs["api_base"] = worker_kwargs["api_base"][:-4]

        # Make json_formatting_instruction conditional (only for local/Ollama models)
        is_local_ollama = (
            model.startswith("ollama")
            or model.startswith("ollama_chat")
            or "local" in model
        )
        json_formatting_instruction = ""
        if is_local_ollama:
            json_formatting_instruction = (
                "\nCRITICAL: When calling tools, you must format your response as a valid JSON block. "
                "Ensure that all double quotes inside 'JSON string arguments are properly escaped as \\\". "
                "Do NOT write literal backslash-n ('\\n') strings in the code; write the code structure normally.\n"
                "WARNING: If you receive a SYSTEM ALERT about violating the tool-only rule, it means you outputted plain text instead of a JSON tool call. "
                "To correct this, DO NOT use send_message to apologize or pretend the fix is done. You MUST re-issue the proper action tool call (e.g., write_file, run_command) in proper JSON format."
                "within the JSON string and ensure the JSON format is valid.\n"
                "Example of calling send_message:\n"
                "```json\n"
                "{\n"
                "  \"name\": \"send_message\",\n"
                "  \"arguments\": {\"message\": \"I have finished the task. Here is the summary...\"}\n"
                "}\n"
                "```\n"
            )

        system = (
            "#ROLE: "
            "You are a problem-solving agent. You must use your available tools and skills "
            "to fulfill the user's request provided in your context. "
            "\n--- CRITICAL WORKER RULE: TOOL USE ONLY ---\n"
            "You are a PURE TOOL-USE worker. You MUST NOT respond with conversational text, explanations, or plans on your first turn.\n"
            "You MUST call the appropriate tool (e.g. `write_file`, `run_command`, `get_project_overview`, etc.) immediately in your very first response.\n"
            "Do NOT output any preamble, apologies, or confirmation text (like 'Sure, I will do that'). Any response containing ONLY conversational text will immediately terminate your execution, preventing you from calling any tools. ALWAYS call a tool first.\n"
            "--------------------------------------------\n\n"
            "Your specific tools are:\n"
            "  - get_project_overview: Returns the project's folder and file structure. Use it to explore the workspace and locate files.\n"
            "  - read_file: Reads the complete contents of a file. Use it to inspect code or text files entirely.\n"
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
            f"RECOMMENDATION FOR TERMINATION AND send_message:\n"
            f"- Calling send_message OR returning a final text response terminates your execution immediately.\n"
            f"- If you need to do X, do it RIGHT NOW using your tools in this exact same turn. Only terminate when the entire requested task is completely finished, or if you are completely blocked and need human input. Inform final response to user.\n"
            f"- If your task requires using multiple tools (like reading files, running commands, or writing code), do not call send_message first. Use the tools to complete the work, and then call send_message to report the final result.\n"
            f"\n--- EXPECTED BEHAVIOR EXAMPLES ---\n"
            f"Example 1: The user wants you to fix a bug in auth.py.\n"
            f"  [WRONG]: You generate a plain text response or send_message saying 'I found the bug! Here is the corrected code: ```...``` Please update it.' (This is hallucinating a fix without doing the work).\n"
            f"  [CORRECT]: You use the `write_file` tool to overwrite auth.py with the fixed code. Wait for success. THEN use `send_message` to say 'I have applied the fix to auth.py.'\n"
            f"Example 2: The user just asks 'How does auth.py work?' or 'What is wrong with this code?'\n"
            f"  [CORRECT]: You read the code using tools, and then use `send_message` to explain the code or provide code snippets. This is perfectly fine because the user didn't ask you to apply changes.\n"
            f"Example 3: You applied a change, but you want to explain what you did.\n"
            f"  [CORRECT]: You first use `write_file`. Then you use `send_message` to explain: 'I applied the change. I specifically modified the loop logic like this: ```python ... ```'\n"
            f"----------------------------------\n"
            f"CRITICAL COMMUNICATION RULE & PERSONA:\n"
            f"- You are an autonomous backend system. You report your internal tool errors only to the system supervisor. The human user sees only the final result.\n"
            f"- NEVER apologize or mention internal tool errors, rule violations, or JSON formatting issues to the user via send_message. The user does not see your internal tool interactions. If a tool fails, fix the error silently and try again.\n"
            f"CRITICAL THINKING RULE: Keep your internal reasoning extremely brief and concise. DO NOT enter infinite brainstorming loops (e.g. repeatedly asking yourself 'Should I do X? Yes/No. Wait!'). Formulate a quick plan and IMMEDIATELY execute a tool or return.\n"
            f"ACHIEVEMENTS MEMORY INSTRUCTION:\n"
            f"You have access to the 'update_achievements_memory' tool. Use it FREQUENTLY to record your progress and milestones.\n"
            f"Examples of achievements you MUST record:\n"
            f"1. Discovered the location of an important file or snippet.\n"
            f"2. Concluded a heartbeat/iteration (write a summary of what you did in that phase).\n"
            f"3. Successfully read and understood a file's contents, or successfully wrote to a file.\n"
            f"4. Discovered the root cause of an error or bug.\n"
            f"You can output MULTIPLE tool calls in the same response to update achievements alongside your main action.\n"
            f"{json_formatting_instruction}"
        )

        # Tools: the workflow tool set, but with the intercepted send_message so the
        # sub-agent's messages reach the user AND the MemGPT memory.
        tools = [
            t for t in get_available_tools()
            if t.name not in ["send_message"]
        ]
        memgpt._current_worker_messages = []
        tools.append(make_intercepted_send_message(memgpt, skill_name))

        from .config import get_project_agent_params
        worker_agent_params = get_project_agent_params("worker")

        sub_agent = LLMAgentBlock(
            name=f"skill_{skill_name}",
            system_prompt=system,
            model=model,
            tools=tools,
            model_kwargs=worker_kwargs,
            max_iterations=worker_agent_params.get("max_iterations", None),
            max_tool_calls=worker_agent_params.get("max_tool_calls", 40),
            loop_detection=worker_agent_params.get("loop_detection", True),
            loop_detection_limit=worker_agent_params.get("loop_detection_limit", 3),
            tool_role_workaround=worker_agent_params.get("tool_role_workaround", "user" if model.startswith("ollama") else None),
            termination_tools=["send_message"],
        )
        from .litellm_compat import wrap_agent_litellm_compat
        wrap_agent_litellm_compat(sub_agent)

        from opalatex.agent_stdin import print_event
        
        if worker_kwargs.get("stream", False):
            thought_chunks = []
            in_think_block = [False]
            think_buffer = [""]
            
            def _worker_on_thinking(chunk: str) -> None:
                thought_chunks.append(chunk)
                print_event("thought", {"content": chunk, "agent": f"worker:{skill_name}"})

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

        # We always want on_iteration to run for reflection and format fixing
        def _worker_on_iteration(_step: int, messages: list) -> None:
            last = messages[-1] if messages else {}
            content = last.get("content") or ""
            
            if isinstance(content, str) and "SYSTEM ALERT:" in content and "JSON string in plain text" in content:
                content = content.replace("Use the send_message tool to talk to the user", "")
                if "If you need to talk to the user" not in content:
                    feedback = (
                        "\n\nIf you need to talk to the user and end the turn, use send_message, otherwise make a tool call.\n"
                        "Examples:\n"
                        "To act/modify (e.g., read_file):\n"
                        "```json\n"
                        "{\n"
                        "  \"name\": \"read_file\",\n"
                        "  \"arguments\": {\"AbsolutePath\": \"path/to/file.py\"}\n"
                        "}\n"
                        "```\n"
                        "To talk to the user (ONLY if strictly needed to communicate):\n"
                        "```json\n"
                        "{\n"
                        "  \"name\": \"send_message\",\n"
                        "  \"arguments\": {\"message\": \"Your message to the user\"}\n"
                        "}\n"
                        "```\n"
                    )
                    last["content"] = content + feedback
                    content = last["content"]

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
            
        # Check for macro-loop
        for run in memgpt._skill_run_history:
            if run["skill"] == skill_name and run["context"] == context:
                return f"[SYSTEM ALERT] MACRO-LOOP DETECTED: You already delegated to '{skill_name}' with this EXACT context earlier in the session, and it failed or didn't resolve the issue. You MUST change your plan/context, use different instructions, or use 'send_message' to ask the user for help. DO NOT repeat the exact same delegation."
                
        previous_runs = ""
        attempt_count = 1
        for run in memgpt._skill_run_history:
            if run["skill"] == skill_name:
                previous_runs += f"--- Previous attempt {attempt_count} ---\nContext given: {run['context'][:200]}...\nResult/Report: {run['result']}\n\n"
                attempt_count += 1
                
        previous_runs_block = ""
        if previous_runs:
            previous_runs_block = f"\n[PREVIOUS ATTEMPTS HISTORY]\nYou have been called before in this session for the '{skill_name}' skill. Do NOT repeat failed approaches. Here are your previous attempts:\n{previous_runs}"

        prompt = f"RECENT CHAT HISTORY:\n{recent_history}{achievements_block}{previous_runs_block}\n\nMEMGPT CONTEXT/INSTRUCTIONS:\n{context}"
        try:
            out = await sub_agent.run(AgentInput(prompt=prompt))
            out_text = out.response if hasattr(out, "response") else str(out)
            tool_calls = getattr(out, "tool_calls_made", "?")
        except Exception as e:
            out_text = f"[CRITICAL WORKER CRASH] A exceção não tratada interrompeu o worker: {str(e)}"
            tool_calls = "?"

        #if "<<NEED_INPUT>>" in out_text:
        #    parts = out_text.split("<<NEED_INPUT>>", 1)
        #    user_prompt = parts[1].strip() if len(parts) > 1 else "Please provide required input:"
        #    user_response = ask_human(user_prompt)
        #    out_text = out_text.replace("<<NEED_INPUT>>", f"[User provided: {user_response}]")

        # Return the summary of what the worker did to MemGPT
        worker_summary = "\n".join(getattr(memgpt, "_current_worker_messages", []))
        if not worker_summary.strip():
            worker_summary = out_text
            # Se o worker calou a boca e o texto for genérico, alertar o orquestrador que ele pode ter estourado o limite.
            if not worker_summary.strip() or "max iterations reached" in worker_summary.lower():
                worker_summary = f"[AVISO: O worker terminou sem um resumo claro. Ele realizou {tool_calls} chamadas de ferramenta e o último texto gerado foi: {out_text}]"

        memgpt._last_worker_summary = worker_summary

        # Record this run
        memgpt._skill_run_history.append({
            "skill": skill_name,
            "context": context,
            "result": worker_summary
        })

        # import json
        # print(json.dumps({
        #     "event": "info",
        #     "data": {"message": f"Worker '{skill_name}' finalizado. Relatório:\n{worker_summary}"}
        # }), flush=True)

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
        "You are the OpalaTex chat-orchestrator. You operate in a strict TOOL-ONLY environment.\n"
        "1. The runtime prepends today's date to this prompt. If the user asks for recent, latest, current, future-dated, or otherwise time-sensitive information, you MUST use web_search before answering, refusing, or delegating. You MUST NOT hallucinate dates or assume something did not happen without first searching the web.\n" 
        "2. You MUST NEVER reply to the user with plain conversational text. If you want to communicate with the user (to provide analysis, code snippets, or report completion), YOU MUST use the 'send_message' tool with a non-empty message.\n"
        "3. You CAN and SHOULD use your tools (like read_file, write_file, web_search, get_project_overview, search_conversation_history) to investigate the user's request and diagnose the problem first.\n"
        "4. If the user asks for something that you don't know, you can use web_search to find relevant information. If the user asks for something in the project, you can use get_project_overview to explore the project structure and read_file to read files.\n"
        "5. Whenever the user asks a question involving dates, time, recent events, latest events, sports, news, public figures, APIs, or potentially anachronistic information, you must search the web for updated information.\n"
        "6. You can call run_skill to execute tasks. CRITICAL: You must ONLY delegate to skills explicitly listed under 'Available skills'. NEVER invent skill names like 'search_files', 'list_files', or 'edit_file'. If you need to list, search, or read files directly, use get_project_overview or read_file directly.\n"
        "7. AFTER the worker finishes, you will receive its summary. Use a <think> block to reflect on whether the task was fully resolved. If it was NOT resolved or if the worker failed, you MAY call run_skill again with a revised plan. If the task IS complete, you MUST call 'send_message' with a non-empty final result for the user.\n"
        "8. Every invocation of run_skill spawns a completely stateless, ephemeral sub-agent. The worker starts fresh with no memory of prior runs. You MUST NOT try to converse/coordinate with the worker across multiple turns or promise to provide details in a 'next step'. Provide all instructions and details in a single run_skill call.\n"
        "9. If you need to edit or write a large file (more than ~100-200 lines), do NOT instruct the worker to use write_file with the entire content, as LLM output limits will truncate the tool call. Instead, instruct it to use replace_content_range for specific line ranges, write_content_pos only for insertion before a specific line, or write a small Python search-and-replace script and run it using run_command.\n"
        "NEVER assume something didn't happen without first searching the web using the web_search tool.\n"
        "CRITICAL: If you use a <think> block to plan your actions, you MUST NOT stop generating afterwards. You MUST conclude your turn by outputting a valid JSON tool call (either another tool, run_skill, or send_message). An empty text response or a plain text reply without a JSON tool call is a critical failure.\n\n"
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
    model = _apply_modelconfig_provider(model, project)
    _llm_kwargs = get_agent_llm_kwargs("memgpt")
    
    model_params = getattr(project, "model_params", {}) or {}
    enable_achievements = model_params.get("enable_achievements", True)
    
    from .agent_stdin import wrap_tool
    from .tools import create_plan

    orchestrator_tools = [
        wrap_tool(read_core_memory), 
        wrap_tool(read_file), 
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
        tool_role_workaround=_agent_params.get("tool_role_workaround", "user" if model.startswith("ollama") else None),
    )
    from .litellm_compat import wrap_agent_litellm_compat
    wrap_agent_litellm_compat(memgpt)

    #print("BEGIN MEMGPT SYSTEM PROMPT >>>>>>>>>>>>>>")
    #print(system_prompt)
    #print("END MEMGPT SYSTEM PROMPT <<<<<<<<<<<< ")
    
    # Seed the working context from persisted history so the conversation restores
    # across restarts (the old chat_agent did this; the MemGPT starts empty).
    _VALID_ROLES = {"user", "assistant", "system", "tool"}
    history = getattr(project, "history", None) or []
    for msg in history[-10:]:
        role = msg.get("role", "assistant")
        if role not in _VALID_ROLES:
            role = "assistant"
        content = msg.get("content", "")
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

    def _memgpt_on_iteration(_step: int, messages: list) -> None:
        last = messages[-1] if messages else {}
        content = last.get("content") or ""
        
        if isinstance(content, str) and "SYSTEM ALERT:" in content and "JSON string in plain text" in content:
            content = content.replace("Use the send_message tool to talk to the user", "")
            if "If you need to talk to the user" not in content:
                feedback = (
                    "\n\nIf you need to talk to the user and end the turn, use send_message, otherwise make a tool call.\n"
                    "Examples:\n"
                    "To act/modify (e.g., read_file):\n"
                    "```json\n"
                    "{\n"
                    "  \"name\": \"read_file\",\n"
                    "  \"arguments\": {\"AbsolutePath\": \"path/to/file.py\"}\n"
                    "}\n"
                    "```\n"
                    "To talk to the user (ONLY if strictly needed to communicate):\n"
                    "```json\n"
                    "{\n"
                    "  \"name\": \"send_message\",\n"
                    "  \"arguments\": {\"message\": \"Your message to the user\"}\n"
                    "}\n"
                    "```\n"
                )
                last["content"] = content + feedback

    memgpt.on_iteration = _memgpt_on_iteration

    return memgpt
