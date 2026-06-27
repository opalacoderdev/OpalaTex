"""Tools for the OpalaTex Autonomous Agent (MemGPT pattern + HITL)."""
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import functools
import asyncio
import concurrent.futures
from agenticblocks.core.function_block import as_tool

from . import terminal as T

# ─── Shared progress state ───────────────────────────────────────────────────
# The orchestrator reads these to render a live progress panel.

TURN_ACHIEVEMENTS = ""



class _AgentProgress:
    def __init__(self):
        self.heartbeat: int = 0
        self.max_heartbeats: int = 15
        self.tasks_done: int = 0
        self.tasks_total: int = 0
        self.last_tool: str = "—"
        self.last_args: str = ""
        self.start_time: float = time.monotonic()
        self.live_context = None
        # Error / failure tracking
        self.task_failures: int = 0          # reviewer said task NOT DONE
        self.worker_errors: int = 0          # worker returned [ERROR ...]
        self.lint_errors: int = 0            # lint check failures from write/edit
        self.plan_retries: int = 0           # oracle reflection retries
        self.recent_events: list[str] = []   # last N notable events (errors, retries)

    def _push_event(self, msg: str) -> None:
        self.recent_events.append(msg)
        if len(self.recent_events) > 6:
            self.recent_events.pop(0)

    def record_lint_error(self, path: str) -> None:
        self.lint_errors += 1
        short = os.path.basename(path)
        self._push_event(f"[red]✗ lint[/red] {short}")

    def record_worker_error(self, task_id: str, snippet: str = "") -> None:
        self.worker_errors += 1
        snip = snippet[:60].replace("\n", " ") if snippet else ""
        self._push_event(f"[red]✗ worker[/red] {task_id}" + (f": {snip}" if snip else ""))

    def record_task_failure(self, task_id: str, reason: str = "") -> None:
        self.task_failures += 1
        snip = reason[:60].replace("\n", " ") if reason else ""
        self._push_event(f"[yellow]⚠ review[/yellow] {task_id}" + (f": {snip}" if snip else ""))

    def record_plan_retry(self, attempt: int) -> None:
        self.plan_retries += 1
        self._push_event(f"[yellow]⚠ plan retry[/yellow] #{attempt}")

    def update(self, tool_name: str, args_preview: str = "") -> None:
        self.heartbeat += 1
        self.last_tool = tool_name
        self.last_args = args_preview[:80] if args_preview else ""



    def elapsed(self) -> str:
        secs = int(time.monotonic() - self.start_time)
        m, s = divmod(secs, 60)
        return f"{m}m{s:02d}s"


AGENT_PROGRESS = _AgentProgress()

# Set once at session start via set_project_path(); all tools use this as their workspace.
_PROJECT_PATH: str = ""
_PROJECT_SESSION = None
_PROJECT_STORE = None

def set_project_context(session, store=None) -> None:
    global _PROJECT_PATH, _PROJECT_SESSION, _PROJECT_STORE
    _PROJECT_SESSION = session
    _PROJECT_STORE = store
    if session:
        _PROJECT_PATH = os.path.abspath(session.project_path) if getattr(session, "project_path", "") else os.getcwd()

        # Ensure .opalatex/ is ignored by the user's own git so internal
        # files (editor state, skill requests) never appear in their git status.
        try:
            proj_gitignore = os.path.join(_PROJECT_PATH, ".gitignore")
            entry = ".opalatex/"
            existing = ""
            if os.path.isfile(proj_gitignore):
                with open(proj_gitignore, "r", encoding="utf-8") as _f:
                    existing = _f.read()
            if entry not in existing:
                with open(proj_gitignore, "a", encoding="utf-8") as _f:
                    if existing and not existing.endswith("\n"):
                        _f.write("\n")
                    _f.write(f"{entry}\n")
                # Untrack any .opalatex/ files already committed to the user's git index.
                subprocess.run(
                    ["git", "rm", "--cached", "-r", "--ignore-unmatch", ".opalatex/"],
                    cwd=_PROJECT_PATH, capture_output=True
                )
        except Exception:
            pass

        # Load project-specific .env file if it exists
        env_path = os.path.join(_PROJECT_PATH, ".env")
        if os.path.isfile(env_path):
            from dotenv import load_dotenv
            try:
                load_dotenv(dotenv_path=env_path, override=True)
            except Exception:
                pass
                
        # Also explicitly propagate api_key and api_base from session if present
        model_name = getattr(session, "model", None)
        alt_model_name = getattr(session, "worker_model", None)
        env_vars = set()
        from .api_keys import get_env_var_for_model
        if model_name:
            v = get_env_var_for_model(model_name)
            if v:
                env_vars.add(v)
        if alt_model_name:
            v = get_env_var_for_model(alt_model_name)
            if v:
                env_vars.add(v)

        if getattr(session, "api_key", None):
            os.environ["OPENAI_API_KEY"] = session.api_key
            for v in env_vars:
                os.environ[v] = session.api_key
        else:
            # Only pop if they were not loaded from the current project's .env file
            # (which has already been processed by load_dotenv above)
            env_file_has_key = False
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "OPENAI_API_KEY=" in content:
                            env_file_has_key = True
                except Exception:
                    pass
            if not env_file_has_key:
                os.environ.pop("OPENAI_API_KEY", None)

            for v in env_vars:
                env_file_has_v = False
                if os.path.isfile(env_path):
                    try:
                        with open(env_path, "r", encoding="utf-8") as f:
                            content = f.read()
                            if f"{v}=" in content:
                                env_file_has_v = True
                    except Exception:
                        pass
                if not env_file_has_v:
                    os.environ.pop(v, None)

        if getattr(session, "api_base", None):
            os.environ["OPENAI_API_BASE"] = session.api_base
        
        if getattr(session, "worker_api_key", None):
            os.environ["WORKER_API_KEY"] = session.worker_api_key
            
        if getattr(session, "worker_api_base", None):
            os.environ["WORKER_API_BASE"] = session.worker_api_base
        else:
            env_file_has_base = False
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "OPENAI_API_BASE=" in content:
                            env_file_has_base = True
                except Exception:
                    pass
            if not env_file_has_base:
                os.environ.pop("OPENAI_API_BASE", None)

        # Dynamically inject/register the configured context window (num_ctx) in LiteLLM's model mapping
        # so it doesn't fail with a BadRequestError (request exceeds available context window).
        try:
            import litellm
            model_name = getattr(session, "model", None)
            model_params = getattr(session, "model_params", None) or {}
            num_ctx = model_params.get("num_ctx")
            if model_name and num_ctx:
                # Direct registration for model in litellm's dynamic model database
                if model_name not in litellm.model_prices_and_context_window:
                    litellm.model_prices_and_context_window[model_name] = {
                        "max_tokens": num_ctx,
                        "max_input_tokens": num_ctx,
                        "max_output_tokens": num_ctx,
                        "context_window": num_ctx,
                    }
                else:
                    litellm.model_prices_and_context_window[model_name]["context_window"] = num_ctx
                    litellm.model_prices_and_context_window[model_name]["max_tokens"] = num_ctx
                    litellm.model_prices_and_context_window[model_name]["max_input_tokens"] = num_ctx
        except Exception:
            pass
    else:
        _PROJECT_PATH = os.getcwd()


def get_project_path() -> str:
    return _PROJECT_PATH or os.getcwd()


def _resolve_path(path: str) -> str:
    """Make path absolute, rooted at the project directory if relative."""
    if os.path.isabs(path):
        return path
    return os.path.join(get_project_path(), path)


def _preview(value: object, max_len: int = 60) -> str:
    """Return a short, single-line preview of any argument value."""
    s = str(value).replace("\n", " ")
    return s[:max_len] + "…" if len(s) > max_len else s

def _decode_escape_sequences(s: str) -> str:
    """Fix content where the model emitted literal \\n \\t \\r instead of real control chars.

    When a model double-escapes inside a JSON tool argument (\\\\n instead of \\n),
    json.loads produces the two-character sequence backslash-n. We detect this heuristic:
    the string has no real newlines but does contain literal backslash-n sequences,
    indicating the entire content is single-line with escaped line breaks.

    We do a simple targeted replacement of the common escape sequences to avoid
    corrupting multi-byte UTF-8 characters (accents, etc.) that unicode_escape would mangle.
    """
    if "\n" in s:
        return s
    if r"\n" not in s and r"\t" not in s and r"\r" not in s:
        return s
    return (
        s
        .replace(r"\n", "\n")
        .replace(r"\t", "\t")
        .replace(r"\r", "\r")
        .replace(r"\\", "\\")
    )

SAFE_SHELL_COMMANDS = {
    # Linux/macOS
    "ls", "pwd", "cat", "grep", "find", "whoami", "head", "tail", "less", "more", "tree", "cd", "echo",
    # Windows (CMD / PowerShell)
    "dir", "type", "findstr", "Get-ChildItem", "Get-Location", "Get-Content", "Select-String", "tasklist"
}

_DENIED_TOOLS = set()

class UserCancelException(BaseException):
    """Raised to immediately abort the agent turn when a user denies permission."""
    pass

def opalatex_tool(name: str, description: str, is_safe: bool = False):
    """
    Decorator that wraps the agenticblocks tool.
    Enforces 'plan', 'edit', and 'auto' mode safety rules.
    """
    def decorator(func):
        is_async = asyncio.iscoroutinefunction(func)

        def _check_permission(*args, **kwargs):
            mode = getattr(_PROJECT_SESSION, "mode", "auto") if _PROJECT_SESSION else "auto"
            
            # Auto mode or safe tool -> always execute
            if mode == "auto" or is_safe:
                return True
                
            # Check if this tool was set to 'always allow'
            if _PROJECT_SESSION and hasattr(_PROJECT_SESSION, "results"):
                allowed_tools = _PROJECT_SESSION.results.get("allowed_tools", [])
                if name in allowed_tools:
                    return True

            if name in _DENIED_TOOLS:
                return f"Execution blocked: You already asked to use '{name}' and the user DENIED it. Do not try again."

            # Now we are in 'edit' or 'plan' mode, and the tool is NOT safe.
            is_run_command_safe = False
            question = f"O agente quer usar a ferramenta '{name}'. Permitir?"
            
            if name == "run_command":
                cmd = kwargs.get("command") or (args[0] if args else "")
                base_cmd = cmd.strip().split()[0] if cmd else ""
                is_writing = ">" in cmd or "|" in cmd
                if base_cmd in SAFE_SHELL_COMMANDS and not is_writing:
                    is_run_command_safe = True
                else:
                    question = f"O agente quer executar o comando: '{cmd}'. Permitir?"
            
            if is_run_command_safe:
                return True
                
            if mode == "plan":
                return "Execution blocked: In 'plan' mode, you are not allowed to execute operations that modify the system."
                
            if mode == "edit":
                return question
                
            return True

        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            res = _check_permission(*args, **kwargs)
            if isinstance(res, str):
                if res.startswith("Execution blocked"):
                    raise UserCancelException(res)
                
                # Ask user for permission using a custom confirm modal
                import uuid
                import asyncio
                from opalatex.agent_stdin import print_event, _gui_input_pending
                loop = asyncio.get_event_loop()
                req_id = str(uuid.uuid4())
                fut = loop.create_future()
                _gui_input_pending[req_id] = fut
                
                print_event("input_request", {
                    "id": req_id,
                    "prompt": res,
                    "type": "confirm",
                    "options": ["yes", "no", "always"],
                    "default": "yes"
                })
                
                try:
                    raw = await asyncio.wait_for(asyncio.shield(fut), timeout=86400.0) # wait up to 24h
                    ans = str(raw).strip().lower()
                except asyncio.TimeoutError:
                    ans = "no"
                finally:
                    _gui_input_pending.pop(req_id, None)
                    
                if ans not in ("yes", "y", "s", "sim", "true", "1", "always", "a"):
                    _DENIED_TOOLS.add(name)
                    raise UserCancelException(f"Operação cancelada pelo usuário (Modo Edit) para a ferramenta: {name}")
                    
                if ans in ("always", "a"):
                    if _PROJECT_SESSION and hasattr(_PROJECT_SESSION, "results"):
                        if "allowed_tools" not in _PROJECT_SESSION.results:
                            _PROJECT_SESSION.results["allowed_tools"] = []
                        if name not in _PROJECT_SESSION.results["allowed_tools"]:
                            _PROJECT_SESSION.results["allowed_tools"].append(name)
                            
            if is_async:
                return await func(*args, **kwargs)
            else:
                return func(*args, **kwargs)
                
        return as_tool(name=name, description=description)(async_wrapper)
            
    return decorator

# ─── Tools ───────────────────────────────────────────────────────────────────
@opalatex_tool(name="read_file", is_safe=True, description="Read the contents of a file in the project workspace. Relative paths are resolved from the project directory.")
def read_file(path: str) -> str:
    try:
        resolved = _resolve_path(path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    AGENT_PROGRESS.update("read_file", f"path={_preview(resolved)}")
    
    try:
        if os.path.isdir(resolved):
            raise ValueError(f"Error: '{_preview(resolved)}' is a directory, not a file. Use run_command with 'ls' or get_project_overview() to view contents.")
        if not os.path.exists(resolved):
            raise ValueError(f"Error: file not found: {_preview(resolved)}. If you are trying to write code, use 'write_file' instead.")
    except OSError as e:
        # Catch cases like [Errno 36] File name too long if path contains code
        raise ValueError(f"Error: invalid path argument ({e.strerror}). 'read_file' expects a file path, not file contents.")

    try:
        with open(resolved, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        raise ValueError(f"Error reading {_preview(resolved)}: {e}")

@opalatex_tool(name="analyze_image", is_safe=True, description="Analyzes an image file using computer vision and returns a text description. Use this when the user asks you to look at a chart, UI mockup, or any image file.")
def analyze_image(file_path: str, prompt: str = "Describe this image in detail") -> str:
    try:
        import base64
        import mimetypes
        import litellm
        from .config import get_agent_llm_kwargs, get_agent_model
        
        resolved = _resolve_path(file_path)
        if not os.path.exists(resolved) or os.path.isdir(resolved):
            return "infelizmente não consegui analisar sua imagem: arquivo não encontrado ou é um diretório."
            
        content_type, _ = mimetypes.guess_type(resolved)
        if not content_type or not content_type.startswith("image/"):
            content_type = "image/jpeg"
            
        with open(resolved, "rb") as f:
            encoded_img = base64.b64encode(f.read()).decode("utf-8")
            
        kwargs = get_agent_llm_kwargs("memgpt")
        
        # Use the orchestrator's model by default (since it's the one using the tool)
        model = get_agent_model("memgpt")
        if _PROJECT_SESSION:
            project_override = getattr(_PROJECT_SESSION, "model", None)
            if project_override:
                model = project_override
                
        kwargs.pop("stream", None)
        
        try:
            from .memgpt_runtime import _apply_modelconfig_provider
            if _PROJECT_SESSION:
                model = _apply_modelconfig_provider(model, _PROJECT_SESSION)
        except Exception:
            pass
            
        if kwargs.get("api_base"):
            if model.startswith("ollama/") or model.startswith("ollama_chat/"):
                if kwargs["api_base"].endswith("/v1"):
                    kwargs["api_base"] = kwargs["api_base"][:-3]
                elif kwargs["api_base"].endswith("/v1/"):
                    kwargs["api_base"] = kwargs["api_base"][:-4]

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{content_type};base64,{encoded_img}"}
                    }
                ]
            }
        ]
        
        AGENT_PROGRESS.update("analyze_image", f"path={_preview(resolved)}")
        response = litellm.completion(model=model, messages=messages, **kwargs)
        return response.choices[0].message.content or "infelizmente não consegui analisar sua imagem."
        
    except litellm.exceptions.BadRequestError as e:
        return f"CRITICAL ERROR: The model ({model}) rejected the request. Explicitly inform the user that this model likely does not support Computer Vision (not multimodal) or the image is too large. Technical detail: {str(e)}"
    except litellm.exceptions.AuthenticationError as e:
        return f"CRITICAL ERROR: Authentication failed for model {model}. EXPLÍCITLY tell the user that they need to specify the API Key for this model in the top bar (under 'Edit Models'). Technical detail: {str(e)}"
    except litellm.exceptions.APIConnectionError as e:
        return f"CRITICAL ERROR: Connection failed with the model's API ({model}). Tell the user to verify if the local server (e.g., Ollama) is running or if the URL is correct. Technical detail: {str(e)}"
    except Exception as e:
        return f"CRITICAL ERROR: An internal error occurred while analyzing the image using the model {model}. Tell the user the following reason: {str(e)}"

@opalatex_tool(name="write_file", is_safe=False, description="Write or overwrite a file inside the project directory. Relative paths are resolved from the project directory. Creates parent directories if needed. ALWAYS use this tool to save file content — never use run_command with echo/printf/cat to write files, as shell quoting will break with multi-line or HTML/JSON content.")
def write_file(path: str, content: str) -> str:
    try:
        resolved = _resolve_path(path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    AGENT_PROGRESS.update("write_file", f"path={_preview(resolved)}")
    
    try:
        if os.path.isdir(resolved):
            raise ValueError(f"Error: '{_preview(resolved)}' is a directory. Cannot write to a directory.")
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ValueError(f"Error: invalid path argument ({e.strerror}).")

    try:
        content = _decode_escape_sequences(content)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
        try:
            from .code_index import CODE_INDEX
            CODE_INDEX.rebuild_file(resolved)
        except Exception:
            pass
            
        return f"Successfully wrote to {_preview(resolved)}."
    except Exception as e:
        raise ValueError(f"Error writing {_preview(resolved)}: {e}")


import platform
_os_info = f"{platform.system()} ({platform.release()})"
_run_cmd_desc = f"Execute a non-interactive shell command (e.g. ls, dir, mkdir, grep, npm install). Runs inside the project directory. Returns stdout/stderr. NEVER run servers or infinite processes. NEVER use echo/printf/cat to write file content — use write_file instead. NOTE: Host OS is {_os_info}. Use the appropriate shell commands."

@opalatex_tool(name="run_command", is_safe=False, description=_run_cmd_desc)
def run_command(command: str) -> str:
    AGENT_PROGRESS.update("run_command", f"$ {_preview(command)}")
    cwd = get_project_path()
    try:
        res = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=120,
            cwd=cwd,
        )
        out = res.stdout.strip()
        err = res.stderr.strip()
        # Truncate large outputs
        if len(out) > 2000:
            out = out[:1000] + "\n... [TRUNCATED] ...\n" + out[-500:]
        if len(err) > 2000:
            err = err[:1000] + "\n... [TRUNCATED] ...\n" + err[-500:]
        import json
        result = {
            "stdout": out,
            "stderr": err,
            "exit_code": res.returncode
        }
        return json.dumps({"result": json.dumps(result, indent=2)})
    except subprocess.TimeoutExpired:
        raise ValueError("Error: Command timed out after 120 seconds.")
    except Exception as e:
        raise ValueError(f"Error running command: {e}")

@opalatex_tool(name="run_background_command", is_safe=False, description="Start a long-running background command or server (e.g., `npm run dev`) directly in the user's MAIN IDE terminal. This runs asynchronously and returns immediately, allowing the agent to continue working while the server runs. NEVER use this for commands where you need to see the output to proceed.")
async def run_background_command(command: str) -> str:
    import json
    import urllib.request
    
    AGENT_PROGRESS.update("background_cmd", f"$ {_preview(command)}")
    cwd = get_project_path()

    try:
        req = urllib.request.Request(
            "http://127.0.0.1:3000/api/terminal/input",
            data=json.dumps({
                "action": "input",
                "text": f"{command}\r",
                "term_id": "main",
                "projectPath": cwd
            }).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=2.0) as response:
            if response.status == 200:
                return f"SUCCESS: The command '{command}' has been sent to the main background terminal and is now running."
            else:
                return f"FAILED to start background command: HTTP {response.status}"
    except Exception as e:
        return f"FAILED to send command to background terminal: {str(e)}"


@opalatex_tool(name="run_python_script", is_safe=False, description="Execute a Python script securely. It automatically uses the correct Python interpreter for the environment. Provide the script path and any optional arguments.")
def run_python_script(script_path: str, args: str = "") -> str:
    try:
        resolved = _resolve_path(script_path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    cmd = f'"{sys.executable}" "{resolved}" {args}'.strip()
    AGENT_PROGRESS.update("run_python_script", f"$ {_preview(cmd)}")
    cwd = get_project_path()
    try:
        res = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=120,
            cwd=cwd,
        )
        out = res.stdout.strip()
        err = res.stderr.strip()
        # Truncate large outputs
        if len(out) > 2000:
            out = out[:1000] + "\n... [TRUNCATED] ...\n" + out[-500:]
        if len(err) > 2000:
            err = err[:1000] + "\n... [TRUNCATED] ...\n" + err[-500:]
        import json
        result = {
            "stdout": out,
            "stderr": err,
            "exit_code": res.returncode
        }
        return json.dumps({"result": json.dumps(result, indent=2)})
    except subprocess.TimeoutExpired:
        raise ValueError("Error: Command timed out after 120 seconds.")
    except Exception as e:
        raise ValueError(f"Error running script: {e}")

@opalatex_tool(name="run_interactive_command", is_safe=False, description="Run a command that requires user interaction (e.g. npm create, interactive scripts, prompts). This opens a dedicated interactive terminal popup in the user's GUI, allowing them to answer the prompts safely. Use this WHENEVER a command needs human choices, waits for input, or requires a PTY. Do NOT use standard `exec` or `run_command` for interactive tasks, as they will hang.")
async def run_interactive_command(command: str) -> str:
    import uuid
    import opalatex.terminal as T
    
    AGENT_PROGRESS.update("interactive_cmd", _preview(command))
    term_id = "temp_" + str(uuid.uuid4())[:8]

    # Trigger the interactive terminal modal in the UI
    res = await T.a_interactive_terminal(command, term_id)
    
    if res and res.lower() not in ("cancel", "no", "false"):
        return f"SUCCESS: The interactive command '{command}' finished successfully according to the user."
    else:
        return f"FAILURE: The user indicated that the interactive command '{command}' failed or was cancelled. Please ask the user for details if needed."

@opalatex_tool(name="search_code", is_safe=True, description="Search for a specific string across all files using grep. Searches inside the project directory by default.")
def search_code(query: str, path: str = ".") -> str:
    try:
        resolved = _resolve_path(path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    AGENT_PROGRESS.update("search_code", f"query={_preview(query)} path={_preview(resolved)}")
    try:
        res = subprocess.run(
            f"grep -rnI --exclude-dir='.git' --exclude-dir='node_modules' --exclude-dir='__pycache__' '{query}' {resolved}",
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=get_project_path(),
        )
        return res.stdout if res.stdout else "No matches."
    except Exception as e:
        raise ValueError(f"Error searching code in {_preview(resolved)}: {e}")

@opalatex_tool(
    name="ask_human",
    is_safe=True,
    description=(
        "Pause execution and ask the human a critical question. "
        "Use ONLY for genuinely dangerous or irreversible operations such as: "
        "running 'rm -rf', 'sudo' commands, accessing credentials, or modifying files outside the workspace. "
        "NEVER use for: creating directories, creating files, writing code, installing common packages (npm, pip), "
        "or any standard development task. Just do those things directly."
    )
)
async def ask_human(question: str) -> str:
    AGENT_PROGRESS.update("ask_human", _preview(question))
    
    import opalatex.terminal as T
    ans = await T.aask(question)
    
    if not ans:
        return "The user did not provide an answer or cancelled the prompt."
    return f"The user responded: {ans}"


@opalatex_tool(
    name="get_project_overview",
    is_safe=True,
    description=(
        "Return a compact overview of the current project: directory tree (max depth defined by parameter max_depth, DEFAULT/MINIMUM 5), "
        "file count by type, and a summary of key files (README, package.json, requirements.txt, etc.). "
        "Call this at the start of any task to understand the project before acting. ALWAYS specify max_depth of at least 5."
    ),
)
def get_project_overview(max_depth:int = 5) -> str:
    from .config import get_project_overview_max_depth
    AGENT_PROGRESS.update("get_project_overview")
    root = Path(get_project_path())
    
    try:
        if max_depth < 0:
            max_depth_cfg = get_project_overview_max_depth()
        else:
            max_depth_cfg = max_depth
            
        # FORCE MINIMUM DEPTH
        if max_depth_cfg < 5:
            max_depth_cfg = 5

        if not root.exists():
            return f"Project directory does not exist yet: {root}"

        # ── Directory tree (skip hidden & node_modules/__pycache__) ──
        SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", "dist", "build"}

        def _tree(path: Path, depth: int = 0) -> list[str]:
            if depth >= max_depth_cfg:
                return ["  " * depth + "..."]
            lines = []
            try:
                entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
            except PermissionError:
                return []
            for entry in entries:
                if entry.name.startswith(".") or entry.name in SKIP:
                    continue
                indent = "  " * depth
                lines.append(indent + entry.name + ("/" if entry.is_dir() else ""))
                if entry.is_dir():
                    lines.extend(_tree(entry, depth + 1))
            return lines

        tree_lines = _tree(root)
        tree_str = f"{root.name}/\n" + "\n".join(tree_lines) if tree_lines else f"{root.name}/  (empty)"

        # ── File count by extension ──
        ext_count: dict[str, int] = {}
        total = 0
        for p in root.rglob("*"):
            if p.is_file() and not any(part in SKIP or part.startswith(".") for part in p.parts):
                ext = p.suffix.lower() or "(no ext)"
                ext_count[ext] = ext_count.get(ext, 0) + 1
                total += 1
        ext_summary = ", ".join(
            f"{ext}: {n}" for ext, n in sorted(ext_count.items(), key=lambda x: -x[1])[:8]
        )

        # ── Key file snapshots ──
        KEY_FILES = ["README.md", "package.json", "requirements.txt", "pyproject.toml",
                     "Makefile", "Dockerfile", "docker-compose.yml", ".env.example"]
        snippets = []
        for name in KEY_FILES:
            kf = root / name
            if kf.exists():
                try:
                    content = kf.read_text(encoding="utf-8", errors="replace")[:400]
                    snippets.append(f"### {name}\n{content.strip()}")
                except Exception:
                    pass

        parts = [
            f"## Project: {root.name}",
            f"Path: {root}",
            f"Total files: {total}  |  By type: {ext_summary or 'n/a'}",
            "",
            "## Directory structure",
            tree_str,
        ]
        if snippets:
            parts += ["", "## Key files"] + snippets

        return "\n".join(parts)
    except Exception as e:
        return f"Error generating project overview: {e}"

@opalatex_tool(
    name="write_content_pos",
    is_safe=False,
    description=(
        "Insert content into a file starting at a specific line number (1-indexed). "
        "The new content will be inserted just before the specified line."
    )
)
def write_content_pos(path: str, content: str, pos: int) -> str:
    try:
        resolved = _resolve_path(path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    AGENT_PROGRESS.update("write_content_pos", f"path={_preview(resolved)} pos={pos}")
    
    try:
        if os.path.isdir(resolved):
            raise ValueError(f"Error: '{_preview(resolved)}' is a directory. Cannot write to a directory.")
        if not os.path.exists(resolved):
            raise ValueError(f"Error: file not found: {_preview(resolved)}.")
    except OSError as e:
        raise ValueError(f"Error: invalid path argument ({e.strerror}).")

    try:
        with open(resolved, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        idx = max(0, min(pos - 1, len(lines)))
        
        if content and not content.endswith('\n'):
            content += '\n'
            
        lines.insert(idx, content)
        
        with open(resolved, "w", encoding="utf-8") as f:
            f.writelines(lines)
            
        return f"Successfully inserted content at line {pos} in {_preview(resolved)}."
    except Exception as e:
        raise ValueError(f"Error writing to {_preview(resolved)}: {e}")

@opalatex_tool(
    name="read_content_pos",
    is_safe=True,
    description=(
        "Read a specific range of lines from a file. "
        "start_pos and end_pos are 1-indexed line numbers (inclusive)."
    )
)
def read_content_pos(path: str, start_pos: int, end_pos: int) -> str:
    try:
        resolved = _resolve_path(path)
    except Exception as e:
        raise ValueError(f"Error resolving path: {e}")

    AGENT_PROGRESS.update("read_content_pos", f"path={_preview(resolved)} lines={start_pos}-{end_pos}")
    
    try:
        if os.path.isdir(resolved):
            raise ValueError(f"Error: '{_preview(resolved)}' is a directory, not a file.")
        if not os.path.exists(resolved):
            raise ValueError(f"Error: file not found: {_preview(resolved)}.")
    except OSError as e:
        raise ValueError(f"Error: invalid path argument ({e.strerror}).")

    try:
        with open(resolved, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        start_idx = max(0, start_pos - 1)
        end_idx = min(len(lines), end_pos)
        
        if start_idx >= len(lines):
            raise ValueError(f"Error: start_pos {start_pos} is beyond the end of the file (total lines: {len(lines)}).")
            
        selected_lines = lines[start_idx:end_idx]
        return "".join(selected_lines)
    except Exception as e:
        raise ValueError(f"Error reading {_preview(resolved)}: {e}")

def _rel(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root)
    except ValueError:
        return path

def get_available_tools():
    return [
        search_conversation_history,
        update_achievements_memory,
        get_project_overview,
        read_file,
        read_content_pos,
        write_file,
        write_content_pos,
        run_command,
        run_interactive_command,
        analyze_image
    ]

# ─── Achievements Memory ─────────────────────────────────────────────────────
@opalatex_tool(
    name="update_achievements_memory", 
    is_safe=True,
    description=(
        "Update the transient Achievements Memory with a summary of the important milestones and tasks "
        "you have accomplished so far during this turn. Keep it concise (e.g. bullet points). "
        "This memory is passed to worker sub-agents so they know what has already been done. "
        "Use this FREQUENTLY for: discovering an important file, finishing a heartbeat iteration, "
        "successfully reading/writing a file, or finding the root cause of a bug."
    )
)
def update_achievements_memory(summary: str) -> str:
    global TURN_ACHIEVEMENTS
    AGENT_PROGRESS.update("update_achievements_memory", f"summary={summary[:50]}")
    TURN_ACHIEVEMENTS = summary
    try:
        from opalatex.agent_stdin import print_event
        print_event("achievements_update", {"content": summary})
    except Exception as e:
        pass
    return "Achievements Memory updated successfully."

# ─── Long-Term Memory (MemGPT-style) ──────────────────────────────────────────
@opalatex_tool(name="read_core_memory", is_safe=True, description="Read the global 'Core Memory' of the project. Contains rules, persistent context, and architectural decisions you should follow.")
def read_core_memory() -> str:
    AGENT_PROGRESS.update("read_core_memory")
    if not _PROJECT_SESSION:
        return "Core memory not available (no active session)."
    
    if getattr(_PROJECT_SESSION, "use_shared_memory", True):
        return getattr(_PROJECT_SESSION, "core_memory", "") or "(Core memory is empty)"
    else:
        if not _PROJECT_STORE:
            return "(Core memory is empty)"
        mem = _PROJECT_STORE.get_chat_core_memory(_PROJECT_SESSION.name, getattr(_PROJECT_SESSION, "current_chat_id", "main"))
        return mem or "(Core memory is empty)"

@opalatex_tool(name="append_core_memory", is_safe=False, description="Append a new persistent rule, context, or decision to the Core Memory. Do this when you learn something about the user's preferences or the project's state that you want to remember across different executions.")
def append_core_memory(content: str) -> str:
    AGENT_PROGRESS.update("append_core_memory", f"content={_preview(content)}")
    if not _PROJECT_SESSION or not _PROJECT_STORE:
        return "Core memory not available (no active session)."
    
    use_shared = getattr(_PROJECT_SESSION, "use_shared_memory", True)
    
    if use_shared:
        current = getattr(_PROJECT_SESSION, "core_memory", "")
        new_mem = current + ("\n" if current else "") + "- " + content
        _PROJECT_SESSION.core_memory = new_mem
        try:
            _PROJECT_STORE.save(_PROJECT_SESSION)
            return "Successfully appended to global Core Memory."
        except Exception as e:
            raise ValueError(f"Error saving Core Memory: {e}")
    else:
        chat_id = getattr(_PROJECT_SESSION, "current_chat_id", "main")
        current = _PROJECT_STORE.get_chat_core_memory(_PROJECT_SESSION.name, chat_id)
        new_mem = current + ("\n" if current else "") + "- " + content
        try:
            _PROJECT_STORE.update_chat_core_memory(_PROJECT_SESSION.name, chat_id, new_mem)
            return f"Successfully appended to chat '{chat_id}' isolated Core Memory."
        except Exception as e:
            raise ValueError(f"Error saving isolated Core Memory: {e}")

@opalatex_tool(name="search_conversation_history", is_safe=True, description="Search through the past conversations of this project using semantic search (RAG) to remember previous context, decisions, or user instructions. Use this when you need context about past tasks.")
def search_conversation_history(query: str, limit: int = 5) -> str:
    AGENT_PROGRESS.update("search_conversation_history", f"query={_preview(query)}")
    if not _PROJECT_SESSION:
        return "Archival search not available (no active session)."
    
    try:
        from .archival import search_archival
        chat_id = None
        if not getattr(_PROJECT_SESSION, "use_shared_memory", True):
            chat_id = getattr(_PROJECT_SESSION, "current_chat_id", "main")
        results = search_archival(_PROJECT_SESSION.name, query, limit=limit, chat_id=chat_id)
        if not results:
            return f"No results found in archival memory for query: '{query}'"
            
        out = [f"Found {len(results)} results in Archival Memory:"]
        for r in results:
            out.append(f"[{r['timestamp']} | {r['role'].upper()}] {r['content']}")
        return "\n".join(out)
    except Exception as e:
        raise ValueError(f"Error searching Archival Memory: {e}")

@opalatex_tool(
    name="create_plan",
    is_safe=True,
    description=(
        "Presents a proposed implementation plan to the user for approval. "
        "Use this tool when you are in 'plan' mode and have gathered enough context to propose a plan. "
        "This tool halts execution and waits for the user to approve or reject the plan."
    )
)
async def create_plan(plan_content: str) -> str:
    AGENT_PROGRESS.update("create_plan")
    if not _PROJECT_SESSION:
        return "Failed: No active session."
    
    T.info("Presenting Proposed Plan to user for approval...")
    
    # Emit custom input_request with markdown_content instead of using T.aconfirm
    import uuid
    import asyncio
    from opalatex.agent_stdin import print_event, _gui_input_pending
    
    loop = asyncio.get_event_loop()
    req_id = str(uuid.uuid4())
    fut = loop.create_future()
    _gui_input_pending[req_id] = fut
    
    print_event("input_request", {
        "id": req_id,
        "prompt": "Review the proposed plan below:",
        "markdown_content": plan_content,
        "type": "confirm",
        "options": ["yes", "no"],
        "default": "yes"
    })
    
    try:
        raw = await asyncio.wait_for(asyncio.shield(fut), timeout=86400.0) # wait up to 24h
        
        # Try parsing JSON if the frontend sent the edited content
        import json
        try:
            data = json.loads(raw)
            approved_str = data.get("response", "no")
            edited_plan = data.get("editedContent", plan_content)
        except Exception:
            approved_str = raw.strip()
            edited_plan = plan_content
            
        approved = approved_str.lower() in ("yes", "y", "s", "sim", "true", "1")
    except asyncio.TimeoutError:
        approved = True
        edited_plan = plan_content
    finally:
        _gui_input_pending.pop(req_id, None)
    
    if approved:
        _PROJECT_SESSION.mode = "auto"
        if edited_plan != plan_content:
            _PROJECT_SESSION.plan_text = edited_plan
            # We don't save to db yet, it'll be saved at the end of the turn by agent_stdin
        return f"The user APPROVED the plan. The system is now in 'auto' mode. Proceed to execute the plan.\n\nPlan Content:\n{edited_plan}"
    else:
        # Throw an error to halt the agent immediately and prevent it from continuing
        raise ValueError("The user REJECTED the plan. Wait for the user to provide feedback in the chat.")


@opalatex_tool(
    name="web_search",
    is_safe=True,
    description=(
        "Search the web for current information, documentation, news, or any topic. "
        "Use this when you need information that may be recent, external, or not in your training data. "
        "Returns a list of results with titles, URLs and snippets. "
        "Requires web search to be enabled in OpalaTex settings."
    ),
)
def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using DuckDuckGo (default) or the configured MCP server."""
    AGENT_PROGRESS.update("web_search", f"query={_preview(query)}")
    try:
        from .web_search_config import is_enabled, do_search
    except ImportError as exc:
        return f"[web_search] Configuration module unavailable: {exc}"

    if not is_enabled():
        return (
            "[web_search] Web search is currently disabled. "
            "Enable it via the Web Search toggle in the OpalaTex chat panel."
        )

    # Bridge the async do_search into the synchronous tool interface.
    # Always use a fresh ThreadPoolExecutor so that asyncio.run() creates its own
    # event loop in a clean thread — this is safe regardless of whether the caller
    # is the main thread, an async worker thread (agenticblocks), or any other
    # context.  Using asyncio.get_event_loop() in Python 3.10+ raises RuntimeError
    # when called from a thread that never had an event loop (e.g. 'asyncio_0').
    import concurrent.futures
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(__import__("asyncio").run, do_search(query, max_results))
            return future.result(timeout=30)
    except Exception as exc:
        return f"[web_search] Search failed: {exc}"
