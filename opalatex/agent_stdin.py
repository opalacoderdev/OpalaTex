"""JSON-based stdin/stdout protocol for calling OpalaTex agents."""

import sys
import json
import asyncio
import os
import time
import io
import re

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

# Worker send_message calls are emitted as info events. Keep the latest worker
# messages only as context for corrective retries when the orchestrator finishes
# silently; they must not become a final assistant response by themselves.
_LAST_WORKER_MESSAGES: list[str] = []
_LAST_INTERMEDIATE_AGENT_RESPONSE = ""
EMPTY_RESPONSE_MAX_CORRECTION_ATTEMPTS = 2
_ACTIVE_THOUGHT_CHUNKS: list[str] | None = None
_ACTIVE_THOUGHT_CHARS = 0
_ACTIVE_THOUGHT_SUPPRESSED = False
MAX_THOUGHT_CHARS_PER_TURN = 24_000
MAX_THOUGHT_CHUNK_CHARS = 4_000

# Pending GUI input requests: maps request-id -> asyncio.Future so that the
# /api/opalatex/input_response endpoint can resolve them.
_gui_input_pending: dict = {}

import litellm

# Ollama (and some other local providers) don't support params like
# presence_penalty. Drop unsupported params silently instead of crashing.
litellm.drop_params = True
# OpalaTex agents use Chat Completions-style tool loops. Do not let LiteLLM
# globally reroute OpenAI chat calls to the stateful Responses API.
litellm.route_all_chat_openai_to_responses = False

# ── Register model cost for the OpalaTex Cloud proxy model ──────────────────
# The Cloud proxy routes approved openai/gemini-* aliases to Google Gemini via
# opalacoder.com. LiteLLM has no built-in cost entry for this custom routing,
# so register_model emits a DeprecationWarning about missing cache cost fields
# on every Router deployment (once per session, per model_id hash).
#
# We register the canonical provider-prefixed name with cache cost fields set
# to 0.0 (billing is handled server-side via token_balance, not via LiteLLM's
# cost map), which silences the warning for the alias entry.
#
# The Router also registers under a SHA-256 model_id hash (derived from
# litellm_params including api_key), which is unstable across sessions and
# cannot be pre-registered. We suppress that specific warning via a logging
# filter so it doesn't pollute the console without affecting other warnings.
try:
    litellm.register_model({
        "openai/gemini-3.5-flash-lite": {
            "litellm_provider": "openai",
            "mode": "chat",
            "input_cost_per_token": 0.0,
            "output_cost_per_token": 0.0,
            "cache_creation_input_token_cost": 0.0,
            "cache_read_input_token_cost": 0.0,
        },
        "openai/gemini-3.1-flash-lite": {
            "litellm_provider": "openai",
            "mode": "chat",
            "input_cost_per_token": 0.0,
            "output_cost_per_token": 0.0,
            "cache_creation_input_token_cost": 0.0,
            "cache_read_input_token_cost": 0.0,
        },
        "openai/gemini-3.5-flash": {
            "litellm_provider": "openai",
            "mode": "chat",
            "input_cost_per_token": 0.0,
            "output_cost_per_token": 0.0,
            "cache_creation_input_token_cost": 0.0,
            "cache_read_input_token_cost": 0.0,
        },
    })
except Exception:
    pass

import logging as _logging

class _RegisterModelCostFilter(_logging.Filter):
    """Suppress only the register_model cache-cost warning (hash-based id).

    The hash-based model_id is unstable (depends on api_key/api_base in
    litellm_params), so it cannot be pre-registered. This filter silences
    that specific message without affecting other LiteLLM warnings.
    """
    def filter(self, record: _logging.LogRecord) -> bool:
        msg = record.getMessage() if hasattr(record, "getMessage") else str(record)
        if "not in built-in cost map and no prefix/region variant matched" in msg:
            return False
        return True

try:
    litellm.verbose_logger.addFilter(_RegisterModelCostFilter())
except Exception:
    pass

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

    from opalatex.i18n import _

    if "not found" in low or "pull" in low or "try pulling it first" in low:
        if model.startswith("ollama/"):
            return _("err_ollama_model_not_found", model=model.replace("ollama/", ""))
        return _("err_model_not_found", model=model)

    if "authentication" in low or "api key" in low or "unauthorized" in low:
        return _("err_auth_failed").format(model=model)

    if "retired" in low:
        return f"O modelo {model} foi descontinuado (retired) e não pode mais ser utilizado."

    if "connection" in low or "connect" in low:
        return _("err_connection_failed").format(model=model)

    if "context" in low and ("length" in low or "window" in low or "exceed" in low):
        return _("err_context_exceeded").format(model=model)

    if "insufficient_quota" in low or "insufficient quota" in low or "billing" in low or "credit" in low or "balance" in low:
        return _("err_insufficient_quota", model=model)

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


def clear_worker_message_buffer() -> None:
    """Clear worker messages captured outside the final agent_response path."""
    global _LAST_INTERMEDIATE_AGENT_RESPONSE
    _LAST_WORKER_MESSAGES.clear()
    _LAST_INTERMEDIATE_AGENT_RESPONSE = ""


def record_worker_message(message: str) -> None:
    """Record a worker send_message for corrective retry context."""
    text = str(message or "").strip()
    if text:
        _LAST_WORKER_MESSAGES.append(text)


def _worker_summary_response(agent) -> str:
    """Return the latest worker-facing summary for corrective retry context."""
    if _LAST_INTERMEDIATE_AGENT_RESPONSE.strip():
        return _LAST_INTERMEDIATE_AGENT_RESPONSE.strip()

    worker_response = str(getattr(agent, "_last_worker_chat_response", "") or "").strip()
    if worker_response:
        return worker_response

    messages = [
        str(m).strip()
        for m in getattr(agent, "_current_worker_messages", []) or []
        if str(m).strip()
    ]
    if messages:
        return "\n".join(messages)

    summary = str(getattr(agent, "_last_worker_summary", "") or "").strip()
    if summary:
        return summary

    if _LAST_WORKER_MESSAGES:
        return "\n".join(_LAST_WORKER_MESSAGES)

    for item in reversed(getattr(agent, "internal_history", []) or []):
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        summary = _extract_worker_summary_from_tool_result(content)
        if summary:
            return summary

    return ""


def _extract_worker_summary_from_tool_result(content: str) -> str:
    """Extract a worker report from a run_skill tool result."""
    marker = "Worker's summary/report:"
    if marker not in content:
        return ""

    summary = content.split(marker, 1)[1].strip()
    lines = summary.splitlines()
    if lines and lines[0].strip().startswith("(Tools used by worker:"):
        summary = "\n".join(lines[1:]).strip()
    return summary


def _response_with_thought(response: str, thought_chunks: list[str]) -> str:
    """Return the content safe to persist in chat history."""
    text = _strip_empty_think_blocks(str(response or "")).strip()
    return _visible_chat_response(text)


def _visible_chat_response(response: str) -> str:
    """Return the only content allowed in chat history or user-visible chat."""
    visible, _thoughts = _split_channel_markup(response)
    return _strip_empty_think_blocks(visible).strip()


def _strip_empty_think_blocks(content: str) -> str:
    """Remove empty thinking sections produced by local reasoning models."""
    return re.sub(r"<think>\s*</think>\s*", "", str(content or ""), flags=re.IGNORECASE)


def _split_think_tags(content: str) -> tuple[str, list[str]]:
    """Extract non-empty <think> blocks from visible model output."""
    thoughts: list[str] = []

    def _collect(match: re.Match) -> str:
        thought = match.group(1).strip()
        if thought:
            thoughts.append(thought)
        return "\n"

    visible = re.sub(
        r"<think>([\s\S]*?)</think>",
        _collect,
        str(content or ""),
        flags=re.IGNORECASE,
    )
    visible = _strip_empty_think_blocks(visible).strip()
    return visible, thoughts


def _strip_chat_control_tokens(content: str) -> str:
    """Remove raw chat-template control tokens from model output."""
    text = str(content or "")
    text = re.sub(r"<\|message\|>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<\|end\|>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<\|start\|>[^<\r\n]*", "", text, flags=re.IGNORECASE)
    return text.strip()


def _split_channel_markup(content: str) -> tuple[str, list[str]]:
    """Split gpt-oss/Ollama channel markup into visible text and thought text."""
    text = str(content or "")
    marker_re = re.compile(
        r"<\|channel\|>\s*([A-Za-z0-9_-]+)\s*(?:<\|message\|>)?",
        flags=re.IGNORECASE,
    )
    matches = list(marker_re.finditer(text))
    if not matches:
        return _split_think_tags(text)

    visible_parts: list[str] = []
    thought_parts: list[str] = []
    if matches[0].start() > 0:
        visible_parts.append(_strip_chat_control_tokens(text[:matches[0].start()]))

    reasoning_channels = {"thought", "analysis", "reasoning"}
    visible_channels = {"final", "commentary", "assistant"}
    for index, match in enumerate(matches):
        channel = match.group(1).lower()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        segment = _strip_chat_control_tokens(text[match.end():end])
        if not segment:
            continue
        if channel in reasoning_channels:
            thought_parts.append(segment)
        elif channel in visible_channels:
            visible_parts.append(segment)
        else:
            visible_parts.append(segment)

    visible, embedded_thoughts = _split_think_tags("\n\n".join(part for part in visible_parts if part))
    return visible, thought_parts + embedded_thoughts


def _sanitize_model_response(response: str, thought_chunks: list[str]) -> str:
    """Move raw reasoning-channel output into thought storage and return visible text."""
    visible, channel_thoughts = _split_channel_markup(response)
    for thought in channel_thoughts:
        cleaned = thought.strip()
        if cleaned:
            thought_chunks.append(cleaned)
    return visible.strip()


def _looks_like_degenerate_thought(text: str) -> bool:
    """Detect provider loops that stream mostly one repeated token/character."""
    if len(text) < 120:
        return False
    compact = re.sub(r"\s+", "", text)
    if len(compact) < 80:
        return False
    if re.fullmatch(r"(?:\\u[0-9a-fA-F]{4}){20,}", compact):
        return True
    most_common = max(compact.count(ch) for ch in set(compact))
    if most_common / len(compact) >= 0.85:
        return True
    for width in range(1, min(16, len(compact) // 8) + 1):
        unit = compact[:width]
        if unit and unit * (len(compact) // width) == compact[: width * (len(compact) // width)]:
            if len(compact) // width >= 12:
                return True
    return False


def _record_turn_thought(content: str) -> bool:
    """Record a thought chunk for the active chat turn, if it is useful."""
    global _ACTIVE_THOUGHT_CHARS, _ACTIVE_THOUGHT_SUPPRESSED

    text = str(content or "")
    if not text or _ACTIVE_THOUGHT_CHUNKS is None:
        return bool(text)

    if _ACTIVE_THOUGHT_SUPPRESSED:
        return False

    if (
        len(text) > MAX_THOUGHT_CHUNK_CHARS
        or _ACTIVE_THOUGHT_CHARS + len(text) > MAX_THOUGHT_CHARS_PER_TURN
        or _looks_like_degenerate_thought(text)
    ):
        _ACTIVE_THOUGHT_SUPPRESSED = True
        diagnostic = (
            "[Thought stream suppressed: the model emitted an excessively long "
            "or repetitive reasoning stream. The run will continue, but this "
            "diagnostic was kept out of resume context.]"
        )
        _ACTIVE_THOUGHT_CHUNKS.append(diagnostic)
        return False

    _ACTIVE_THOUGHT_CHARS += len(text)
    _ACTIVE_THOUGHT_CHUNKS.append(text)
    return True


def _empty_response_retry_prompt(worker_summary: str = "") -> str:
    """Build the corrective prompt used when the orchestrator ends silently."""
    from opalatex.i18n import _

    prompt = _("empty_response_nudge")
    summary = str(worker_summary or "").strip()
    if summary:
        prompt += (
            "\n\nThe worker already completed work and returned this summary. "
            "Use it to produce the final user-facing message; do not repeat the work:\n"
            f"{summary}"
        )
    return prompt


def _empty_response_failure_message() -> str:
    """Return the localized hard failure for missing final send_message."""
    from opalatex.i18n import _

    return _("empty_response_unresolved_error")


def print_event(event: str, data: dict):
    global _LAST_INTERMEDIATE_AGENT_RESPONSE
    if event == "agent_response" and data.get("intermediate"):
        response = str(data.get("response") or "").strip()
        if response:
            _LAST_INTERMEDIATE_AGENT_RESPONSE = response
            record_worker_message(response)
        event = "info"
        data = {
            "message": response,
            "agent": data.get("agent"),
        }

    already_recorded_thought = bool(data.pop("_thought_recorded", False))
    if event == "thought" and not already_recorded_thought:
        if not _record_turn_thought(data.get("content", "")):
            return

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
            elif event == "error":
                thought_content = f"Alert: An error occurred during execution: {data.get('message', '')}"
                
            if thought_content and _record_turn_thought(thought_content):
                hook({"event": "thought", "content": thought_content})
        except Exception as ex:
            import sys
            sys.stderr.write(f"[DEBUG] Error invoking event hook: {ex}\n")


def _attachment_alias(index: int, att: dict) -> str:
    name = att.get("name") or "attachment"
    _, ext = os.path.splitext(name)
    if not ext:
        mime = att.get("mime", "")
        if mime == "application/pdf":
            ext = ".pdf"
        elif mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            ext = ".docx"
        elif mime == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            ext = ".pptx"
        elif mime.startswith("image/"):
            ext = "." + mime.split("/", 1)[1].replace("jpeg", "jpg")
    return f"input_file_{index}{ext or ''}"


def _attachment_summary(att: dict, alias: str) -> str:
    name = att.get("name") or alias
    att_type = att.get("type", "")
    mime = att.get("mime", "")
    if att_type == "image":
        return f"- {alias}: image attachment '{name}' ({mime or 'image'})"
    if att_type == "pdf_text":
        chars = len(att.get("data", "") or "")
        label = "PDF" if mime == "application/pdf" else "document"
        return f"- {alias}: {label} attachment '{name}' ({chars} extracted text chars)"
    return f"- {alias}: attachment '{name}' ({mime or att_type or 'unknown'})"


def _recent_history_attachments(history: list, *, limit: int = 3) -> list[dict]:
    attachments: list[dict] = []
    for msg in reversed(history or []):
        if msg.get("role") != "user":
            continue
        for att in reversed(msg.get("_attachments") or []):
            if att.get("type") in ("image", "pdf_text"):
                attachments.append(att)
                if len(attachments) >= limit:
                    return list(reversed(attachments))
    return list(reversed(attachments))

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
    replace_content_range,
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
    "replace_content_range": replace_content_range,
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
        #print(f"\n[TOOL-CALL] >>> {name} args={json.dumps(dump_kwargs, ensure_ascii=False)[:300]}", flush=True)
        
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
            #print(f"[TOOL-RESULT] <<< {name} is_error={is_error} result={str(res_val)[:300]}\n", flush=True)
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
    display_prompt = str(data.get("display_prompt") or "").strip()
    messages_history = data.get("messages", [])
    requested_tools = data.get("tools")
    raw_attachments = data.get("attachments", [])  # [{type, data, mime, name}]
    client_message_id = str(data.get("client_message_id") or "").strip()
    
    # Setup project context if provided
    if "project_path" in data or "project_name" in data:
        await handle_load_project(data)

    initial_project_mode = None
    if current_project:
        initial_project_mode = current_project.mode
        # Record the mode at the start of this turn in chat history.
        # This gives the agent a reliable audit trail entry for every turn,
        # independent of what mode the system prompt currently injects.
        if current_store and agent_type in ("orchestrator", "chat_orchestrator"):
            current_store.append_message(
                current_project,
                "system",
                f"[MODE] Agent turn started. Current mode: '{initial_project_mode}'.",
            )

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
        
        # Thinking defaults off for inline agents; orchestrator/memgpt get think=True
        # from _CORE_AGENT_DEFAULTS in config.py. Workers stay False unless the user
        # explicitly enables thinking in project settings.
        model_kwargs["think"] = bool(model_params.get("think", False))
        model_kwargs["stream"] = bool(model_params.get("stream", False))

        agent_kwargs = {}
        if model_params.get("max_iterations") is not None:
            agent_kwargs["max_iterations"] = int(model_params["max_iterations"])
        if model_params.get("max_tool_calls") is not None:
            agent_kwargs["max_tool_calls"] = int(model_params["max_tool_calls"])

        from opalatex.config import (
            resolve_model_for_thinking,
            get_agent_model,
            get_agent_llm_kwargs,
            sanitize_litellm_kwargs_for_model,
        )
        
        _model = model or DEFAULT_MODEL
        _model = resolve_model_for_thinking(_model, model_kwargs)
        
        _agent_name = agent_type or "custom_agent"
        _model = get_agent_model(_agent_name, _model)
        
        # Merge global kwargs so we get the cloud API base and keys
        _global_kwargs = get_agent_llm_kwargs(_agent_name)
        _global_kwargs.update(model_kwargs)
        model_kwargs = sanitize_litellm_kwargs_for_model(_model, _global_kwargs)

        from opalatex.ui_settings import load_ui_settings
        _is_cloud = load_ui_settings().get("ai_provider") == "cloud"
        if agent_kwargs.get("tool_role_workaround") is None:
            agent_kwargs["tool_role_workaround"] = "user" if _model.startswith("ollama") else None
        #print(system_prompt)
        agent = LLMAgentBlock(
            name=agent_type or "custom_agent",
            system_prompt=system_prompt,
            model=_model,
            tools=tools_list,
            model_kwargs=model_kwargs,
            **agent_kwargs
        )
        #print("WORKER SPROMPT ", system_prompt)

    from opalatex.litellm_compat import wrap_agent_litellm_compat
    wrap_agent_litellm_compat(agent)
    
    # Setup message history if provided (for custom/standard LLMAgentBlock)
    if messages_history and hasattr(agent, "internal_history"):
        agent.internal_history.clear()
        for msg in messages_history:
            agent.internal_history.append({
                "role": msg.get("role", "user"),
                "content": msg.get("content", "")
            })
            
    global _ACTIVE_THOUGHT_CHUNKS, _ACTIVE_THOUGHT_CHARS, _ACTIVE_THOUGHT_SUPPRESSED
    thought_chunks = []
    _ACTIVE_THOUGHT_CHUNKS = thought_chunks
    _ACTIVE_THOUGHT_CHARS = 0
    _ACTIVE_THOUGHT_SUPPRESSED = False
    in_think_block = [False]
    think_buffer = [""]

    def _on_thinking(chunk: str) -> None:
        if _record_turn_thought(chunk):
            print_event("thought", {"content": chunk, "agent": agent_type, "_thought_recorded": True})

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

    turn_checkpoint_project_path = None
    turn_checkpoint_id = None
    if agent_type in ("orchestrator", "chat_orchestrator") and current_project and current_project.project_path:
        try:
            from opalatex.config import get_git_strategy
            if get_git_strategy().lower() != "none":
                from opalatex.vcs import begin_agent_turn_checkpoint
                turn_checkpoint_project_path = current_project.project_path
                turn_checkpoint_id = begin_agent_turn_checkpoint(turn_checkpoint_project_path)
        except Exception:
            turn_checkpoint_id = None

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

            user_history_content = display_prompt or prompt
            history_attachments = []
            if not raw_attachments and current_project:
                history_attachments = _recent_history_attachments(getattr(current_project, "history", []) or [])

            attachments_for_turn = list(raw_attachments or history_attachments)
            final_attachments = []
            for att in attachments_for_turn:
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

            attachment_aliases = {
                _attachment_alias(idx, att): att
                for idx, att in enumerate(final_attachments)
                if att.get("type") in ("image", "pdf_text")
            }
            tools_mod.set_recent_file_attachments(attachment_aliases)

            if final_attachments:
                source = "current message" if raw_attachments else "recent chat history"
                summaries = [
                    _attachment_summary(att, _attachment_alias(idx, att))
                    for idx, att in enumerate(final_attachments)
                ]
                prompt += (
                    f"\n\n[Attachment context from {source}. These files are attached to this LLM message. "
                    f"Use the visual/document content directly when possible. If a tool asks for a file path, "
                    f"use the listed alias exactly. For document aliases, read_file(alias) extracts the original attached file.]\n"
                    + "\n".join(summaries)
                )

            # Save user message to store immediately so it's not lost if the agent crashes
            if agent_type in ("orchestrator", "chat_orchestrator") and current_store and current_project:
                try:
                    current_store.append_message(
                        current_project,
                        "user",
                        user_history_content,
                        attachments=raw_attachments,
                        client_message_id=client_message_id,
                    )
                except TypeError:
                    current_store.append_message(current_project, "user", user_history_content, attachments=raw_attachments)
                current_store.save(current_project)

            if agent_type in ("orchestrator", "chat_orchestrator"):
                clear_worker_message_buffer()
                agent._current_worker_messages = []
                agent._last_worker_summary = ""
                agent._last_worker_chat_response = ""
                agent._worker_response_emitted = False

            with apply_meta_params(agent, _meta_overrides):
                resp_obj = await agent.run(AgentInput(prompt=prompt, attachments=final_attachments))
            response = _sanitize_model_response(resp_obj.response or "", thought_chunks)
            
            empty_response_attempts = 0
            while not response and empty_response_attempts < EMPTY_RESPONSE_MAX_CORRECTION_ATTEMPTS:
                empty_response_attempts += 1
                worker_summary = _worker_summary_response(agent)
                from opalatex.i18n import _
                print_event("info", {"message": _("empty_response_retry_info")})
                retry_prompt = _empty_response_retry_prompt(worker_summary)
                with apply_meta_params(agent, _meta_overrides):
                    resp_obj = await agent.run(AgentInput(prompt=retry_prompt))
                response = _sanitize_model_response(resp_obj.response or "", thought_chunks)

            if not response:
                raise RuntimeError(_empty_response_failure_message())
            
            if thought_chunks:
                pass
                #print(f"[DIAG-PY] thought_chunks len={len(thought_chunks)}, full_thought len={len(full_thought)}", flush=True)
                # Only prepend thinking blocks for chat agents — not for inline_editor or
                # other worker agents where the response is expected to be a raw code block.
                # Prepending would cause App.jsx to extract the thinking text instead of the code.
                # App.jsx already prepends the thought snapshot from thought events.
            #else:
                #print(f"[DIAG-PY] thought_chunks EMPTY - thinking not detected in stream", flush=True)

            #print(f"[DIAG-PY] response[:200] = {repr(response[:200])}", flush=True)

            persisted_response = _response_with_thought(response, thought_chunks)
            assistant_message_id = None

            # Save assistant response and achievements
            if agent_type in ("orchestrator", "chat_orchestrator") and current_store and current_project:
                if tools_mod.TURN_ACHIEVEMENTS:
                    current_store.append_message(current_project, "system", f"Achievements logged during this turn:\n{tools_mod.TURN_ACHIEVEMENTS}")
                if persisted_response:
                    assistant_message_id = current_store.append_message(current_project, "assistant", persisted_response)
                # Persist plan approval: if create_plan() switched mode to 'auto' this turn,
                # keep that change so the next turn knows the plan was already approved.
                # Only revert genuinely transient mode changes that were NOT plan approvals.
                if 'initial_project_mode' in locals() and initial_project_mode:
                    if current_project.mode == "auto" and initial_project_mode != "auto":
                        # Plan was approved — the _record_mode_event() inside create_plan()
                        # already wrote the [PLAN APPROVED] entry. Keep 'auto'.
                        pass
                    elif current_project.mode != initial_project_mode:
                        # Some other transient change — revert and record it.
                        current_store.append_message(
                            current_project,
                            "system",
                            f"[MODE] Transient mode change ('{current_project.mode}') reverted to "
                            f"'{initial_project_mode}' at end of turn.",
                        )
                        current_project.mode = initial_project_mode
                current_store.save(current_project)

            response_payload = {"response": response}
            if agent_type in ("orchestrator", "chat_orchestrator"):
                response_payload["persisted_response"] = persisted_response
                if assistant_message_id is not None:
                    response_payload["message_id"] = assistant_message_id
            print_event("agent_response", response_payload)
        except opalatex.tools.UserCancelException as e:
            # The user denied a tool operation; gracefully abort the turn without feeding an error back to the LLM.
            print_event("agent_response", {"response": "Turno cancelado pelo usuário."})
            print_event("error", {"message": str(e), "trace": ""})
        except Exception as e:
            import traceback
            err_msg = traceback.format_exc()
            user_msg = _friendly_llm_error(e, current_project)
            if (
                current_store
                and current_project
                and agent_type in ("orchestrator", "chat_orchestrator")
            ):
                current_store.append_message(
                    current_project,
                    "assistant",
                    f"Agent Error: {user_msg}",
                )
            print_event("error", {"message": user_msg, "trace": err_msg})
    finally:
        if turn_checkpoint_id and turn_checkpoint_project_path:
            try:
                from opalatex.vcs import finalize_agent_turn_checkpoint
                finalize_agent_turn_checkpoint(turn_checkpoint_project_path, turn_checkpoint_id)
            except Exception:
                pass
        T._async_confirm_hook = orig_async_confirm_hook
        T._async_ask_hook = orig_async_ask_hook
        _ACTIVE_THOUGHT_CHUNKS = None

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
