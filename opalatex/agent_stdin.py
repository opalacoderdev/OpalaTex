"""JSON-based stdin/stdout protocol for calling OpalaTex agents."""

import sys
import json
import asyncio
import os
import time
import io

# ── Force UTF-8 on all I/O streams (critical for PyInstaller --windowed) ─────
os.environ["PYTHONUTF8"] = "1"

def _force_utf8_stream(stream):
    """Return a UTF-8 stream, or a safe fallback wrapper."""
    if stream is None:
        return stream
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
        return stream
    except Exception:
        pass
    try:
        binary = getattr(stream, "buffer", None)
        if binary is not None:
            wrapper = io.TextIOWrapper(binary, encoding="utf-8", errors="replace", line_buffering=True)
            wrapper.mode = getattr(stream, "mode", "w")
            return wrapper
    except Exception:
        pass
    class _UnicodeSafeStream:
        encoding = "utf-8"
        def __init__(self, s): self._stream = s
        def write(self, text):
            try: self._stream.write(text)
            except UnicodeEncodeError:
                try: self._stream.write(text.encode("utf-8", "replace").decode("ascii", "replace"))
                except Exception: pass
            except Exception: pass
        def flush(self):
            try: self._stream.flush()
            except Exception: pass
        def __getattr__(self, name): return getattr(self._stream, name)
    return _UnicodeSafeStream(stream)

sys.stdout = _force_utf8_stream(sys.stdout)
sys.stderr = _force_utf8_stream(sys.stderr)


# Save real stdout and redirect sys.stdout to sys.stderr to prevent pollution
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# Hook to intercept event prints (e.g. for Python GUI server)
event_hook = None

# Pending GUI input requests: maps request-id -> asyncio.Future so that the
# /api/opalatex/input_response endpoint can resolve them.
_gui_input_pending: dict = {}

import litellm

# Ollama (and some other local providers) don't support params like
# presence_penalty. Drop unsupported params silently instead of crashing.
litellm.drop_params = True

from opalatex.chat_meta_params import parse_meta_params, apply_meta_params

def _friendly_llm_error(exc: Exception, project=None) -> str:
    """Convert a LiteLLM/agent exception into a user-friendly message."""
    msg = str(exc)
    low = msg.lower()
    model = getattr(project, "model", None) or "the configured model"

    if "unexpected keyword argument" in low or "got an unexpected" in low:
        # Extract the parameter name from messages like: "got an unexpected keyword argument 'reasoning_effort'"
        import re
        m = re.search(r"unexpected keyword argument ['\"]([^'\"]+)['\"]", msg)
        param = m.group(1) if m else "unknown"
        return (
            f"Parameter '{param}' is not supported by {model}. "
            f"Remove it with: /set-model-param {param} (leave value empty) or check the model's documentation."
        )

    if "invalid value for" in low or "invalid_request_error" in low or "badrequest" in low:
        return f"The model rejected a parameter value: {msg}"

    if "not found" in low or "pull" in low or "try pulling it first" in low:
        if model.startswith("ollama/"):
            return f"O modelo `{model.replace('ollama/', '')}` não foi encontrado localmente ou ainda está sendo baixado em segundo plano pelo Ollama. Por favor, aguarde alguns instantes até o fim do download e tente enviar a mensagem novamente!"
        return f"Model {model} not found or needs to be pulled. Please check if it exists."

    from opalatex.i18n import _
    if "connection" in low or "connect" in low:
        return _("err_connection_failed").format(model=model)

    if "authentication" in low or "api key" in low or "unauthorized" in low:
        return _("err_auth_failed").format(model=model)

    if "context" in low and ("length" in low or "window" in low or "exceed" in low):
        return _("err_context_exceeded").format(model=model)

    if "ratelimit" in low or "rate limit" in low or "429" in low or "quota exceeded" in low or "resource_exhausted" in low:
        import re
        from opalatex.ui_settings import load_ui_settings
        ui_cfg = load_ui_settings()
        is_cloud = ui_cfg.get("ai_provider") == "cloud"
        
        delay_match = re.search(r"please retry in ([\d\.]+)s", low)
        delay_str = f" Aguarde cerca de {round(float(delay_match.group(1)))} segundos e tente novamente." if delay_match else " Aguarde alguns instantes e tente novamente."
        
        if is_cloud:
            return (
                f"Você atingiu o limite da API para o modelo {model} (Cota de tokens por minuto estourada)."
                f"{delay_str} Dica: Isso costuma acontecer ao pedir para a IA ler arquivos gigantes de uma só vez."
            )
        return f"Você atingiu o limite de requisições (Rate Limit) do provedor para o modelo {model}.{delay_str}"

    return msg


def print_event(event: str, data: dict):
    payload = {"event": event, **data}
    hook = event_hook
    if not hook:
        hook = getattr(litellm, "event_hook", None)
    # Write to stdout only in CLI/stdin mode (no server hook active)
    if not hook:
        try:
            if _real_stdout and not getattr(_real_stdout, 'closed', False):
                _real_stdout.write(json.dumps(payload) + "\n")
                _real_stdout.flush()
        except (ValueError, OSError, AttributeError):
            pass
    if hook:
        try:
            hook(payload)
            
            # Emit auxiliary thoughts to keep the Thinking tab active and alive
            thought_content = None
            if event == "agent_started":
                from opalatex.ui_settings import load_ui_settings
                ui_cfg = load_ui_settings()
                if ui_cfg.get("ai_provider") == "cloud":
                    thought_content = f"Starting execution of agent '{data.get('agent', '')}' using Opala Cloud..."
                else:
                    thought_content = f"Starting execution of agent '{data.get('agent', '')}' using model '{data.get('model', '')}'..."
            elif event == "tool_call":
                thought_content = f"Decided to execute tool '{data.get('tool', '')}' with parameters: {json.dumps(data.get('arguments', {}))}"
            elif event == "tool_result":
                if data.get("is_error"):
                    thought_content = f"Tool '{data.get('tool', '')}' returned an error. Analyzing the failure..."
                else:
                    thought_content = f"Received successful return from tool '{data.get('tool', '')}'. Analyzing the obtained result..."
            elif event == "agent_response":
                thought_content = "Response generated successfully by the model. Finishing agent turn."
            elif event == "error":
                thought_content = f"Alert: An error occurred during execution: {data.get('message', '')}"
                
            if thought_content:
                hook({"event": "thought", "content": thought_content})
        except Exception as ex:
            import sys
            sys.stderr.write(f"[DEBUG] Error invoking event hook: {ex}\n")

from opalatex.config import DEFAULT_MODEL, DEFAULT_DB_PATH
from opalatex.project import ProjectStore, ProjectData
from opalatex.memgpt_runtime import build_chat_orchestrator
from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock

# Import all tools
from opalatex.tools import (
    read_file as raw_read_file_base,
    write_file,
    run_command,
    run_python_script,
    run_interactive_command,
    search_code,
    ask_human,
    get_project_overview,
    write_content_pos,
    read_content_pos,
    set_project_context,
    web_search,
    analyze_image,
)

# Global map of available tools by name
ALL_TOOLS_MAP = {
    "read_file": raw_read_file_base,
    "write_file": write_file,
    "run_command": run_command,
    "run_python_script": run_python_script,
    "run_interactive_command": run_interactive_command,
    "search_code": search_code,
    "ask_human": ask_human,
    "get_project_overview": get_project_overview,
    "write_content_pos": write_content_pos,
    "read_content_pos": read_content_pos,
    "web_search": web_search,
    "analyze_image": analyze_image,
}

# State for persistent session
current_project = None
current_store = None
current_memgpt = None

def wrap_tool(original_tool):
    """Wrap a tool to output events on call and completion."""
    from pydantic import BaseModel
    from agenticblocks.core.function_block import FunctionBlock
    
    if getattr(original_tool, "_is_wrapped", False):
        return original_tool

    if not hasattr(original_tool, "run"):
        name = getattr(original_tool, "name", None) or getattr(original_tool, "__name__", None)
        desc = getattr(original_tool, "description", None) or getattr(original_tool, "__doc__", None)
        original_tool = FunctionBlock(original_tool, name=name, description=desc)
        
    name = getattr(original_tool, "name", None) or getattr(original_tool, "__name__", None)
    original_run = original_tool.run
    
    async def wrapped_run(*args, **kwargs) -> BaseModel:
        # Resolve the input_data (BaseModel) correctly
        if args and isinstance(args[0], BaseModel):
            input_data = args[0]
        elif "input" in kwargs and isinstance(kwargs["input"], BaseModel):
            input_data = kwargs["input"]
        else:
            # Fallback if args/kwargs don't match expected pattern
            raise TypeError("wrapped_run expects a Pydantic BaseModel as its first argument or 'input' keyword argument.")
            
        dump_kwargs = input_data.model_dump()
        print_event("tool_call", {"tool": name, "arguments": dump_kwargs})
        print(f"\n[TOOL-CALL] >>> {name} args={json.dumps(dump_kwargs, ensure_ascii=False)[:300]}", flush=True)
        
        global _recent_tool_calls
        if '_recent_tool_calls' not in globals():
            globals()['_recent_tool_calls'] = []
            
        call_signature = f"{name}:{json.dumps(dump_kwargs, sort_keys=True)}"
        _recent_tool_calls.append(call_signature)
        if len(_recent_tool_calls) > 10:
            _recent_tool_calls.pop(0)
            
        count = 0
        for sig in reversed(_recent_tool_calls):
            if sig == call_signature:
                count += 1
            else:
                break
                
        is_error = False
        res_val = "Execution cancelled or failed unexpectedly."
        try:
            import opalatex.agent_stdin
            proj = getattr(opalatex.agent_stdin, "current_project", None)
            loop_enabled = True
            loop_limit = 3
            if proj and hasattr(proj, "model_params") and isinstance(proj.model_params, dict):
                loop_enabled = proj.model_params.get("loop_detection", True)
                loop_limit = proj.model_params.get("loop_detection_limit", 3)

            if loop_enabled and count >= loop_limit:
                raise ValueError(f"Loop detected: You called '{name}' with these exact arguments {count} times in a row without success. Stop repeating this tool call! If this is an interactive CLI command (like npm create), use 'run_interactive_command' instead. Otherwise, try a different approach.")

            result = await original_run(input_data)
            if hasattr(result, "result"):
                res_val = result.result
            else:
                res_val = result.model_dump()
        except Exception as e:
            is_error = True
            res_val = f"Error: {e}"
            print_event("problem", {"tool": name, "message": str(e), "severity": "error"})
            raise
        finally:
            print_event("tool_result", {"tool": name, "result": str(res_val), "is_error": is_error})
            print(f"[TOOL-RESULT] <<< {name} is_error={is_error} result={str(res_val)[:300]}\n", flush=True)
        return result
        
    object.__setattr__(original_tool, "run", wrapped_run)
    object.__setattr__(original_tool, "_is_wrapped", True)
    return original_tool



from opalatex.tools import get_available_tools

# Monkey-patch get_available_tools to automatically wrap tools returned to sub-agents
original_get_available_tools = get_available_tools

def patched_get_available_tools():
    tools = original_get_available_tools()
    return [wrap_tool(t) for t in tools]

import opalatex.tools
import opalatex.memgpt_runtime
opalatex.tools.get_available_tools = patched_get_available_tools
opalatex.memgpt_runtime.get_available_tools = patched_get_available_tools

async def handle_load_project(data: dict):
    global current_project, current_store, current_memgpt
    project_name = data.get("project_name") or "stdin_project"
    project_path = data.get("project_path") or os.getcwd()
    db_path = data.get("db") or DEFAULT_DB_PATH
    
    current_store = ProjectStore(db_path=db_path)
    chat_id = data.get("chat_id", "main")
    if current_store.exists(project_name):
        current_project = current_store.load(project_name, chat_id=chat_id)
        if data.get("project_path"):
            current_project.project_path = os.path.abspath(project_path)
    else:
        current_project = ProjectData(
            name=project_name,
            project_name=project_name,
            project_path=os.path.abspath(project_path),
        )
    
    # Initialize workspace context
    set_project_context(current_project, current_store)
    
    # Rebuild orchestrator
    current_memgpt = build_chat_orchestrator(current_project, current_store)
    
    print_event("project_loaded", {
        "project_name": current_project.project_name,
        "project_path": current_project.project_path,
        "skills": current_project.skills
    })

async def handle_slash_command(data: dict) -> dict:
    """Execute a slash command and return a plain JSON result (no streaming).

    Returns:
        {"status": "done", "messages": [...]}  when the command completes.
        {"status": "confirm", "id": ..., "prompt": ..., "options": [...], "default": ...}
            when the command needs user confirmation before continuing.
    """
    import re
    import uuid

    prompt = data.get("prompt", "")
    cmd, *args = prompt.split(maxsplit=1)

    # Load project state needed by commands
    global current_project, current_store, current_memgpt
    if "project_name" in data or "project_path" in data:
        await handle_load_project(data)

    from opalatex.cli_commands import REPLState, _registry
    import opalatex.terminal as T

    if cmd not in _registry:
        return {"status": "done", "messages": [f"🔴 Comando desconhecido: {cmd}. Digite /help para ajuda."]}

    messages = []

    # ---- Capture terminal output helpers ----
    orig_success         = T.success
    orig_error           = T.error
    orig_info            = T.info
    orig_warning         = T.warning
    orig_confirm         = T.confirm
    orig_ask             = T.ask
    orig_async_confirm_hook = T._async_confirm_hook
    orig_console_print   = T.console.print

    def _capture(*a, prefix=""):
        messages.append(f"{prefix}{' '.join(str(x) for x in a)}")

    T.success = lambda *a, **k: _capture(*a, prefix="🟢 ")
    T.error   = lambda *a, **k: _capture(*a, prefix="🔴 ")
    T.info    = lambda *a, **k: _capture(*a, prefix="ℹ️ ")
    T.warning = lambda *a, **k: _capture(*a, prefix="⚠️ ")
    T.confirm = lambda p, default=True: default   # sync fallback never used in GUI
    T.ask     = lambda p: ""

    def _render_rich(obj) -> str:
        from rich.console import Console as _Console
        from rich.table import Table as _Table
        from io import StringIO
        if isinstance(obj, _Table):
            buf = StringIO()
            c = _Console(file=buf, highlight=False, no_color=True)
            c.print(obj)
            return buf.getvalue()
        return str(obj)

    def _console_print(*args_c, **kwargs_c):
        if not args_c:
            messages.append("")
            return
        raw = " ".join(_render_rich(x) for x in args_c)
        for line in raw.split("\n"):
            stripped = line.strip()
            if not stripped:
                messages.append("")
                continue
            if "Comandos Disponíveis" in stripped or "Available commands" in stripped:
                messages.append("### 🛠️ Comandos Disponíveis\n"); continue
            if "Active skills for this project" in stripped:
                messages.append("### 🧠 Active skills for this project\n"); continue
            if "Available skills" in stripped:
                messages.append("### 📚 Available skills\n"); continue
            clean = re.sub(r'\[/?[\w\s]+\]', '', stripped)
            if clean and clean == clean.upper() and clean.replace(" ", "").isalpha():
                messages.append(f"### {clean}\n"); continue
            m = re.match(r'\s*(?:\*\s*)?\[(green|cyan)\]\s*(.*?)\s*\[/\1\]\s*(.*)', line)
            if m:
                name = m.group(2).strip()
                desc = re.sub(r'\[/?\w+\]', '', m.group(3).strip())
                star = "⭐ " if "*" in line.split("[cyan]")[0] and "[cyan]" in line else "🔹 "
                messages.append(f"{star}**`{name}`** — {desc}"); continue
            cm = re.match(r'^\s*(/[a-zA-Z0-9_<> \-\[\]]+?)\s{2,}(.*)$', line)
            if cm:
                messages.append(f"🔹 **`{cm.group(1).strip()}`** — {cm.group(2).strip()}"); continue
            has_star = bool(re.match(r'^\s*\*\s*', line))
            sm = re.match(r'^\s*(?:\*\s*)?([a-zA-Z0-9_\-]+)\s{2,}(.*)$', line)
            if sm:
                star = "⭐ " if has_star else "🔹 "
                messages.append(f"{star}**`{sm.group(1).strip()}`** — {sm.group(2).strip()}"); continue
            messages.append(re.sub(r'\[/?[\w\s]+\]', '', line))

    T.console.print = _console_print

    # Future that gets resolved either when command finishes OR when it needs confirm
    loop = asyncio.get_event_loop()
    confirm_future: asyncio.Future = loop.create_future()
    confirm_info: dict = {}

    async def _gui_confirm_hook(prompt_text: str, default: bool = True) -> bool:
        req_id = str(uuid.uuid4())
        fut = loop.create_future()
        _gui_input_pending[req_id] = fut
        confirm_info.update({"id": req_id, "prompt": prompt_text,
                             "options": ["yes", "no"],
                             "default": "yes" if default else "no"})
        if not confirm_future.done():
            confirm_future.set_result({"needs_confirm": True})
        try:
            raw = await asyncio.wait_for(asyncio.shield(fut), timeout=120.0)
            return raw.strip().lower() in ("yes", "y", "s", "sim", "true", "1")
        except asyncio.TimeoutError:
            return default
        finally:
            _gui_input_pending.pop(req_id, None)

    T._async_confirm_hook = _gui_confirm_hook

    def _restore():
        T.success            = orig_success
        T.error              = orig_error
        T.info               = orig_info
        T.warning            = orig_warning
        T.confirm            = orig_confirm
        T.ask                = orig_ask
        T._async_confirm_hook = orig_async_confirm_hook
        T.console.print      = orig_console_print

    state    = REPLState(current_project, current_store)
    cmd_args = args[0].split() if args else []

    async def _run_cmd():
        try:
            await _registry.dispatch(state, cmd, cmd_args)
        except Exception as e:
            messages.append(f"🔴 Erro ao executar comando: {e}")
        finally:
            _restore()
            if not confirm_future.done():
                confirm_future.set_result({"needs_confirm": False})

    cmd_task = asyncio.create_task(_run_cmd())

    # Wait until command finishes OR pauses for confirmation
    signal = await confirm_future

    if signal.get("needs_confirm"):
        # Store the running task so /slash-command/continue can resume it
        _pending_slash_tasks[confirm_info["id"]] = (cmd_task, messages)
        return {"status": "confirm", **confirm_info}

    await cmd_task
    response_text = "\n".join(m for m in messages if m is not None) or f"Comando {cmd} concluído."
    return {"status": "done", "messages": [response_text]}


# Pending slash-command tasks awaiting user confirmation
_pending_slash_tasks: dict = {}


async def handle_slash_command_continue(data: dict) -> dict:
    """Resume a slash command after the user responded to a confirm dialog."""
    req_id = data.get("id", "")
    value  = data.get("value", "")

    fut = _gui_input_pending.get(req_id)
    if not fut or fut.done():
        return {"status": "error", "message": "No pending request with that id"}

    loop = asyncio.get_event_loop()
    loop.call_soon_threadsafe(fut.set_result, value)

    entry = _pending_slash_tasks.pop(req_id, None)
    if entry:
        cmd_task, messages = entry
        try:
            await cmd_task
        except Exception:
            pass
        response_text = "\n".join(m for m in messages if m is not None) or "Comando executado com sucesso."
        return {"status": "done", "messages": [response_text]}

    return {"status": "done", "messages": []}


async def handle_run(data: dict):
    global current_project, current_store, current_memgpt
    
    import opalatex.tools
    opalatex.tools._DENIED_TOOLS.clear()
    
    agent_type = data.get("agent") or "chat_orchestrator"
    model = data.get("model")
    system_prompt = data.get("system_prompt")
    raw_prompt = data.get("prompt", "")
    prompt, _meta_overrides = parse_meta_params(raw_prompt)
    messages_history = data.get("messages", [])
    requested_tools = data.get("tools")
    raw_attachments = data.get("attachments", [])  # [{type, data, mime, name}]
    
    # Setup project context if provided
    if "project_path" in data or "project_name" in data:
        await handle_load_project(data)

    initial_project_mode = None
    if current_project:
        initial_project_mode = current_project.mode

    if current_project and current_project.project_path:
        state_dir = os.path.join(current_project.project_path, ".opalatex")
        os.makedirs(state_dir, exist_ok=True)
        state_file = os.path.join(state_dir, "_editor_state.json")
        editor_state = {
            "current_file": data.get("current_file", ""),
            "editor_content": data.get("editor_content", ""),
            "selected_text": data.get("selected_text", "")
        }
        try:
            with open(state_file, "w", encoding="utf-8") as f:
                json.dump(editor_state, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Warning: Failed to save editor state: {e}", file=sys.stderr)
    

    # Build agent
    agent = None
    if agent_type == "chat_orchestrator":
        if not current_memgpt:
            # Autoload default project
            await handle_load_project(data)
        agent = current_memgpt
        if system_prompt:
            agent.system_prompt = system_prompt
    else:
        # Custom LLMAgentBlock
        if not system_prompt:
            print_event("error", {"message": "system_prompt is required for custom agent"})
            return
            
        # >> LOAD CONTEXTUAL SKILL START <<
        if current_project and current_project.project_path:
            current_file = data.get("current_file", "")
            ext = ""
            if current_file:
                _, ext = os.path.splitext(current_file)
                ext = ext.lstrip('.').lower()
            
            contextual_dir = os.path.join(current_project.project_path, ".opalatex", "contextual")
            
            target_skill = os.path.join(contextual_dir, f"contextual_skill_{ext}.skill")
            generic_skill = os.path.join(contextual_dir, "contextual_skill_.skill")
            
            if not os.path.exists(target_skill) or not ext:
                target_skill = generic_skill
                
            try:
                if os.path.exists(target_skill):
                    with open(target_skill, "r", encoding="utf-8") as f:
                        skill_content = f.read().strip()
                    if skill_content:
                        system_prompt += "\n\n# Contextual Instructions:\n" + skill_content
            except Exception as e:
                print(f"Warning: Failed to load contextual skill: {e}", file=sys.stderr)
        # >> LOAD CONTEXTUAL SKILL END <<
        
        # Resolve tools
        tools_list = []
        if requested_tools:
            if requested_tools == "all":
                tools_list = [wrap_tool(t) for t in ALL_TOOLS_MAP.values()]
            else:
                for tname in requested_tools:
                    if tname in ALL_TOOLS_MAP:
                        tools_list.append(wrap_tool(ALL_TOOLS_MAP[tname]))
                    else:
                        print_event("error", {"message": f"Tool '{tname}' not found"})
        
        model_params = data.get("model_params") or {}
        model_kwargs = {}
        if model_params.get("max_tokens") is not None:
            model_kwargs["max_tokens"] = int(model_params["max_tokens"])
        if model_params.get("num_ctx") is not None:
            model_kwargs["num_ctx"] = int(model_params["num_ctx"])
        if model_params.get("temperature") is not None:
            model_kwargs["temperature"] = float(model_params["temperature"])
        if model_params.get("reasoning_effort"):
            model_kwargs["reasoning_effort"] = model_params["reasoning_effort"]
        
        # Default think to False if not explicitly passed as True
        model_kwargs["think"] = bool(model_params.get("think", False))
        model_kwargs["stream"] = bool(model_params.get("stream", False))

        agent_kwargs = {}
        if model_params.get("max_iterations") is not None:
            agent_kwargs["max_iterations"] = int(model_params["max_iterations"])
        if model_params.get("max_tool_calls") is not None:
            agent_kwargs["max_tool_calls"] = int(model_params["max_tool_calls"])

        from opalatex.config import resolve_model_for_thinking, get_agent_model, get_agent_llm_kwargs
        
        _model = model or DEFAULT_MODEL
        _model = resolve_model_for_thinking(_model, model_kwargs)
        
        _agent_name = agent_type or "custom_agent"
        _model = get_agent_model(_agent_name, _model)
        
        # Merge global kwargs so we get the cloud API base and keys
        _global_kwargs = get_agent_llm_kwargs(_agent_name)
        _global_kwargs.update(model_kwargs)
        model_kwargs = _global_kwargs

        from opalatex.ui_settings import load_ui_settings
        _is_cloud = load_ui_settings().get("ai_provider") == "cloud"
        if agent_kwargs.get("tool_role_workaround") is None:
            agent_kwargs["tool_role_workaround"] = "user" if _model.startswith("ollama") else None
        print(system_prompt)
        agent = LLMAgentBlock(
            name=agent_type or "custom_agent",
            system_prompt=system_prompt,
            model=_model,
            tools=tools_list,
            model_kwargs=model_kwargs,
            **agent_kwargs
        )
        #print("WORKER SPROMPT ", system_prompt)
    
    # Setup message history if provided (for custom/standard LLMAgentBlock)
    if messages_history and hasattr(agent, "internal_history"):
        agent.internal_history.clear()
        for msg in messages_history:
            agent.internal_history.append({
                "role": msg.get("role", "user"),
                "content": msg.get("content", "")
            })
            
    thought_chunks = []
    in_think_block = [False]
    think_buffer = [""]

    def _on_thinking(chunk: str) -> None:
        thought_chunks.append(chunk)
        print_event("thought", {"content": chunk, "agent": agent_type})

    def _on_chunk(chunk: str) -> None:
        think_buffer[0] += chunk
        
        while True:
            if not in_think_block[0]:
                if "<think>" in think_buffer[0]:
                    before, rest = think_buffer[0].split("<think>", 1)
                    if before:
                        print_event("stream_chunk", {"content": before, "agent": agent_type})
                    in_think_block[0] = True
                    think_buffer[0] = rest
                else:
                    idx = think_buffer[0].rfind("<")
                    if idx != -1 and "<think>".startswith(think_buffer[0][idx:]):
                        before = think_buffer[0][:idx]
                        if before:
                            print_event("stream_chunk", {"content": before, "agent": agent_type})
                        think_buffer[0] = think_buffer[0][idx:]
                    else:
                        if think_buffer[0]:
                            print_event("stream_chunk", {"content": think_buffer[0], "agent": agent_type})
                            think_buffer[0] = ""
                    break
            else:
                if "</think>" in think_buffer[0]:
                    inside, rest = think_buffer[0].split("</think>", 1)
                    if inside:
                        _on_thinking(inside)
                    in_think_block[0] = False
                    think_buffer[0] = rest
                else:
                    idx = think_buffer[0].rfind("<")
                    if idx != -1 and "</think>".startswith(think_buffer[0][idx:]):
                        before = think_buffer[0][:idx]
                        if before:
                            _on_thinking(before)
                        think_buffer[0] = think_buffer[0][idx:]
                    else:
                        if think_buffer[0]:
                            _on_thinking(think_buffer[0])
                            think_buffer[0] = ""
                    break

    def _on_iteration(_step: int, messages: list) -> None:
        last = messages[-1] if messages else {}
        content = last.get("content") or ""
        if content:
            print_event("reflection", {"content": str(content), "agent": agent_type})

    if hasattr(agent, "on_thinking"):
        agent.on_thinking = _on_thinking
    elif hasattr(agent, "agent") and hasattr(agent.agent, "on_thinking"):
        agent.agent.on_thinking = _on_thinking

    if hasattr(agent, "on_chunk"):
        agent.on_chunk = _on_chunk
    elif hasattr(agent, "agent") and hasattr(agent.agent, "on_chunk"):
        agent.agent.on_chunk = _on_chunk

    if hasattr(agent, "on_iteration"):
        agent.on_iteration = _on_iteration
    elif hasattr(agent, "agent") and hasattr(agent.agent, "on_iteration"):
        agent.agent.on_iteration = _on_iteration

    print_event("agent_started", {"agent": agent_type, "model": agent.model})

    from opalatex.tools import TURN_ACHIEVEMENTS
    import opalatex.tools as tools_mod
    if agent_type == "chat_orchestrator":
        tools_mod.TURN_ACHIEVEMENTS = ""

    import opalatex.terminal as T
    orig_async_confirm_hook = getattr(T, "_async_confirm_hook", None)
    orig_async_ask_hook = getattr(T, "_async_ask_hook", None)
    loop = asyncio.get_event_loop()
    import uuid

    async def _handle_run_confirm_hook(prompt_text: str, default: bool = True) -> bool:
        req_id = str(uuid.uuid4())
        fut = loop.create_future()
        _gui_input_pending[req_id] = fut
        print_event("input_request", {
            "id": req_id,
            "prompt": prompt_text,
            "type": "confirm",
            "options": ["yes", "no"],
            "default": "yes" if default else "no"
        })
        try:
            raw = await asyncio.wait_for(asyncio.shield(fut), timeout=86400.0) # 24h wait
            return raw.strip().lower() in ("yes", "y", "s", "sim", "true", "1")
        except asyncio.TimeoutError:
            return default
        finally:
            _gui_input_pending.pop(req_id, None)

    async def _handle_run_ask_hook(prompt_text: str) -> str:
        req_id = str(uuid.uuid4())
        fut = loop.create_future()
        _gui_input_pending[req_id] = fut
        print_event("input_request", {
            "id": req_id,
            "prompt": prompt_text,
            "type": "ask"
        })
        try:
            raw = await asyncio.wait_for(asyncio.shield(fut), timeout=86400.0) # 24h wait
            return str(raw).strip()
        except asyncio.TimeoutError:
            return ""
        finally:
            _gui_input_pending.pop(req_id, None)

    async def _handle_run_interactive_terminal_hook(command: str, term_id: str) -> str:
        req_id = str(uuid.uuid4())
        fut = loop.create_future()
        _gui_input_pending[req_id] = fut
        print_event("input_request", {
            "id": req_id,
            "type": "interactive_terminal",
            "command": command,
            "term_id": term_id,
            "prompt": "Interactive terminal spawned"
        })
        try:
            raw = await asyncio.wait_for(asyncio.shield(fut), timeout=86400.0) # 24h wait
            return str(raw).strip()
        except asyncio.TimeoutError:
            return ""
        finally:
            _gui_input_pending.pop(req_id, None)

    T._async_confirm_hook = _handle_run_confirm_hook
    T._async_ask_hook = _handle_run_ask_hook
    T._async_interactive_terminal_hook = _handle_run_interactive_terminal_hook

    try:
        try:
            # --- Attachment processing: vision gate + smart PDF truncation ---
            import litellm as _litellm
            _model_name = (current_project.model if current_project else None) or ""

            _mp = getattr(current_project, "model_params", {}) or {}
            # litellm.supports_vision() only knows models in its static registry;
            # local Ollama vision models (e.g. llava, moondream2) are NOT listed there.
            # Setting force_vision=true in model_params lets the user override this.
            _litellm_vision = _litellm.supports_vision(_model_name)
            model_supports_vision = _litellm_vision or bool(_mp.get("force_vision", False))

            pdf_truncate_enabled = _mp.get("pdf_truncate", True)
            pdf_truncate_pct = int(_mp.get("pdf_truncate_pct", 50))
            num_ctx = int(_mp.get("num_ctx", 8192))

            # Rough token estimate: history JSON length / 4 chars-per-token
            _hist = getattr(current_project, "history", []) or []
            history_tokens = len(json.dumps(_hist)) // 4
            free_tokens = max(0, num_ctx - history_tokens)
            free_chars = free_tokens * 4  # back to chars

            final_attachments = []
            for att in raw_attachments:
                att_type = att.get("type", "")
                if att_type == "image" and not model_supports_vision:
                    prompt += (
                        f"\n\n[Note: The user attached image '{att.get('name', 'image')}' "
                        f"but the active model does not support vision. The image was not analysed.]"
                    )
                elif att_type == "pdf_text" and pdf_truncate_enabled:
                    pdf_data = att.get("data", "")
                    pdf_chars = len(pdf_data)
                    allowed_chars = int(free_chars * pdf_truncate_pct / 100)
                    if pdf_chars > allowed_chars and allowed_chars > 0:
                        truncated = pdf_data[:allowed_chars]
                        truncated += (
                            f"\n\n[PDF truncated: {pdf_chars:,} chars total, "
                            f"{allowed_chars:,} shown ({pdf_truncate_pct}% of free context)]"
                        )
                        att = {**att, "data": truncated}
                    final_attachments.append(att)
                else:
                    final_attachments.append(att)

            # Save user message to store immediately so it's not lost if the agent crashes
            if agent_type in ("orchestrator", "chat_orchestrator") and current_store and current_project:
                current_store.append_message(current_project, "user", prompt)
                current_store.save(current_project)

            with apply_meta_params(agent, _meta_overrides):
                resp_obj = await agent.run(AgentInput(prompt=prompt, attachments=final_attachments))
            response = resp_obj.response.strip() if resp_obj.response else ""
            
            if not response:
                from opalatex.i18n import _
                print_event("info", {"message": _("empty_response_retry_info")})
                retry_prompt = _("empty_response_nudge")
                with apply_meta_params(agent, _meta_overrides):
                    resp_obj = await agent.run(AgentInput(prompt=retry_prompt))
                response = resp_obj.response.strip() if resp_obj.response else ""
            
            if thought_chunks:
                full_thought = "".join(thought_chunks).strip()
                #print(f"[DIAG-PY] thought_chunks len={len(thought_chunks)}, full_thought len={len(full_thought)}", flush=True)
                if full_thought and not response.startswith("```thought"):
                    response = f"```thought\n{full_thought}\n```\n\n{response}".strip()
            #else:
                #print(f"[DIAG-PY] thought_chunks EMPTY - thinking not detected in stream", flush=True)

            #print(f"[DIAG-PY] response[:200] = {repr(response[:200])}", flush=True)

            # Save assistant response and achievements
            if agent_type in ("orchestrator", "chat_orchestrator") and current_store and current_project:
                if tools_mod.TURN_ACHIEVEMENTS:
                    current_store.append_message(current_project, "system", f"Achievements logged during this turn:\n{tools_mod.TURN_ACHIEVEMENTS}")
                if response:
                    current_store.append_message(current_project, "assistant", response)
                # Revert any temporary mode changes (like create_plan setting mode to 'auto')
                if 'initial_project_mode' in locals() and initial_project_mode:
                    current_project.mode = initial_project_mode
                current_store.save(current_project)

            print_event("agent_response", {"response": response})
        except opalatex.tools.UserCancelException as e:
            # The user denied a tool operation; gracefully abort the turn without feeding an error back to the LLM.
            print_event("agent_response", {"response": "Turno cancelado pelo usuário."})
            print_event("error", {"message": str(e), "trace": ""})
        except Exception as e:
            import traceback
            err_msg = traceback.format_exc()
            user_msg = _friendly_llm_error(e, current_project)
            print_event("error", {"message": user_msg, "trace": err_msg})
    finally:
        T._async_confirm_hook = orig_async_confirm_hook
        T._async_ask_hook = orig_async_ask_hook

    print_event("agent_finished", {})

async def handle_list_projects(data: dict):
    db_path = data.get("db") or DEFAULT_DB_PATH
    store = ProjectStore(db_path=db_path)
    projects = store.list_projects()
    print_event("projects_list", {"projects": projects})

async def handle_create_project(data: dict):
    db_path = data.get("db") or DEFAULT_DB_PATH
    store = ProjectStore(db_path=db_path)
    
    project_name = data.get("project_name")
    if not project_name:
        print_event("error", {"message": "project_name is required"})
        return
    
    project_path = data.get("project_path") or os.getcwd()
    description = data.get("description", "")
    model = data.get("model") or DEFAULT_MODEL
    mode = data.get("mode") or "auto"
    skills = data.get("skills", [])
    api_key = data.get("api_key")
    api_base = data.get("api_base")
    worker_api_key = data.get("worker_api_key")
    worker_api_base = data.get("worker_api_base")
    model_params = data.get("model_params")
    worker_model_params = data.get("worker_model_params")
    
    abs_proj_path = os.path.abspath(project_path)
    existing_name = store.find_by_path(abs_proj_path)
    
    if existing_name:
        existing_proj = store.load(existing_name)
        existing_project_name = existing_proj.project_name if existing_proj else existing_name
        print_event("error", {"message": _("project_exists_in_folder", name=existing_project_name)})
        return
    else:
        db_key = project_name.replace(" ", "_").lower()
        if store.exists(db_key):
            db_key = f"{db_key}_{int(time.time())}"
            
        project = store.create(
            name=db_key,
            mode=mode,
            model=model,
            project_name=project_name,
            project_path=abs_proj_path,
            skills=skills,
            description=description,
            api_key=api_key,
            api_base=api_base,
            worker_api_key=worker_api_key,
            worker_api_base=worker_api_base,
            model_params=model_params,
            worker_model_params=worker_model_params,
        )
    print_event("project_created", {
        "project_name": project.project_name,
        "project_path": project.project_path,
        "skills": project.skills,
        "api_key": project.api_key,
        "api_base": project.api_base,
        "worker_api_key": project.worker_api_key,
        "worker_api_base": project.worker_api_base,
    })

async def handle_update_project(data: dict):
    db_path = data.get("db") or DEFAULT_DB_PATH
    store = ProjectStore(db_path=db_path)
    
    project_name = data.get("project_name")
    if not project_name:
        print_event("error", {"message": "project_name is required"})
        return
    
    if not store.exists(project_name):
        print_event("error", {"message": f"Project '{project_name}' not found"})
        return
        
    project = store.load(project_name)
    if "display_name" in data:
        project.project_name = data["display_name"]
    if "model" in data and data["model"]:
        project.model = data["model"]
    if "worker_model" in data:
        project.worker_model = data["worker_model"]
    if "description" in data:
        project.description = data["description"]
    if "mode" in data and data["mode"]:
        project.mode = data["mode"]
    if "project_path" in data and data["project_path"]:
        project.project_path = os.path.abspath(data["project_path"])
    if "api_key" in data:
        project.api_key = data["api_key"]
    if "api_base" in data:
        project.api_base = data["api_base"]
    if "worker_api_key" in data:
        project.worker_api_key = data["worker_api_key"]
    if "worker_api_base" in data:
        project.worker_api_base = data["worker_api_base"]
    if "model_params" in data:
        project.model_params = data["model_params"]
    if "worker_model_params" in data:
        project.worker_model_params = data["worker_model_params"]
        
    store.save(project)
    print_event("project_updated", {
        "name": project.name,
        "project_name": project.project_name,
        "project_path": project.project_path,
        "model": project.model,
        "worker_model": project.worker_model,
        "mode": project.mode,
        "description": project.description,
        "api_key": project.api_key,
        "api_base": project.api_base,
        "worker_api_key": project.worker_api_key,
        "worker_api_base": project.worker_api_base,
        "model_params": project.model_params,
    })

async def handle_delete_project(data: dict):
    db_path = data.get("db") or DEFAULT_DB_PATH
    store = ProjectStore(db_path=db_path)
    project_name = data.get("project_name")
    if not project_name:
        print_event("error", {"message": "project_name is required"})
        return
    
    if store.exists(project_name):
        store.delete(project_name)
        print_event("project_deleted", {"project_name": project_name})
    else:
        print_event("error", {"message": f"Project '{project_name}' not found"})

async def stdin_server_loop():
    print_event("server_ready", {})
    
    # Read line by line from stdin
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    
    while True:
        try:
            line_bytes = await reader.readline()
            if not line_bytes:
                break
            line = line_bytes.decode("utf-8").strip()
            if not line:
                continue
            
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                print_event("error", {"message": "Invalid JSON format"})
                continue
                
            cmd = data.get("command")
            if cmd == "exit":
                print_event("exited", {})
                break
            elif cmd == "load_project":
                await handle_load_project(data)
            elif cmd == "run":
                await handle_run(data)
            elif cmd == "list_projects":
                await handle_list_projects(data)
            elif cmd == "create_project":
                await handle_create_project(data)
            elif cmd == "update_project":
                await handle_update_project(data)
            elif cmd == "delete_project":
                await handle_delete_project(data)
            else:
                print_event("error", {"message": f"Unknown command '{cmd}'"})
                
        except KeyboardInterrupt:
            break
        except Exception as e:
            print_event("error", {"message": f"Exception in loop: {e}"})

def start_stdin_server():
    asyncio.run(stdin_server_loop())
