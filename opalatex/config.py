"""Global configuration defaults for OpalaTex."""

import os
import yaml
import pathlib
from dotenv import load_dotenv

# Load local .env
load_dotenv()

# Suppress the non-fatal LiteLLM logging worker warning (coroutine never awaited)
# which frequently occurs in asynchronous contexts on newer Python versions.
import warnings
warnings.filterwarnings(
    "ignore",
    category=RuntimeWarning,
    message=".*coroutine 'Logging.async_success_handler' was never awaited.*"
)

# Load global .env
def get_opalatex_home() -> str:
    if os.environ.get("OPALATEX_HOME"):
        return os.environ["OPALATEX_HOME"]
    pointer_file = pathlib.Path.home() / ".opalatexhome"
    if pointer_file.exists():
        try:
            custom_path = pointer_file.read_text(encoding="utf-8").strip()
            if custom_path and os.path.isdir(custom_path):
                return custom_path
        except Exception:
            pass
    return str(pathlib.Path.home() / ".opalatex")

global_env = pathlib.Path(get_opalatex_home()) / ".env"
if global_env.exists():
    load_dotenv(dotenv_path=global_env)

def _load_yaml(filename: str) -> dict:
    candidates = [
        pathlib.Path(__file__).parent / filename,
        pathlib.Path(__file__).parent.parent / filename,
        pathlib.Path(os.getcwd()) / filename,
    ]
    for config_path in candidates:
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                print(f"Warning: Failed to parse {config_path}: {e}")
    return {}

# Fallback for old imports that might expect a static dict, though they shouldn't.
_AGENTS_CONFIG = {} 
_APP_CONFIG = _load_yaml("config.yaml")

# Hardcoded defaults for internal OpalaTex skills so they work without agents.yaml
_CORE_AGENT_DEFAULTS = {
    "memgpt": {
        "num_ctx": 16384,
        "max_heartbeats": 20,
        "debug": False,
    },
    "landscape_planner": {
        "num_ctx": 8192,
        "reasoning_effort": "none",
    },
    "refinement_agent": {
        "num_ctx": 8192,
        "reasoning_effort": "none",
    },
    "orchestrator": {
        "num_ctx": 16384,
        "max_heartbeats": 20,
        "debug": False,
        "strategy": "workflow",
    },
    "worker": {
        "num_ctx": 16384,
        "reasoning_effort": "none",
        "debug": False,
    }
}

def _deep_merge(target: dict, source: dict) -> dict:
    """Recursively merge source dictionary into target."""
    result = dict(target)
    for k, v in source.items():
        if isinstance(v, dict) and k in result and isinstance(result[k], dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result

def _get_agents_config() -> dict:
    """Dynamically load and merge agents.yaml from User Home and Project Path."""
    # Start with core defaults
    cfg = {"agents": _deep_merge({}, _CORE_AGENT_DEFAULTS)}
    
    # User global
    user_yaml = pathlib.Path(get_opalatex_home()) / "agents.yaml"
    if user_yaml.exists():
        try:
            with open(user_yaml, "r", encoding="utf-8") as f:
                user_cfg = yaml.safe_load(f) or {}
                cfg = _deep_merge(cfg, user_cfg)
        except Exception as e:
            print(f"Warning: Failed to parse {user_yaml}: {e}")
            
    # Project local
    try:
        from .tools import get_project_path
        proj_path = get_project_path()
        proj_yaml = pathlib.Path(proj_path) / ".opalatex" / "agents.yaml"
        if not proj_yaml.exists():
            proj_yaml = pathlib.Path(proj_path) / "agents.yaml"
            
        if proj_yaml.exists():
            with open(proj_yaml, "r", encoding="utf-8") as f:
                proj_cfg = yaml.safe_load(f) or {}
                cfg = _deep_merge(cfg, proj_cfg)
    except Exception as e:
        pass
        
    return cfg

# Model used for all agents (can be overridden via CLI --model)
# Evaluated at module load to serve as CLI defaults (will read ~/.opalatex/agents.yaml if present)
_initial_cfg = _get_agents_config()
DEFAULT_MODEL = _initial_cfg.get("default", os.getenv("OPALATEX_MODEL", "ollama/gemma4:12b"))
WORKER_MODEL = _initial_cfg.get("worker", _initial_cfg.get("alternative", "gemini/gemini-3.1-flash-lite"))

def _get_llm_defaults():
    cfg = _get_agents_config()
    return {
        "temperature": 0.7,
        "num_ctx": 8192,
        **cfg.get("llm_defaults", {}),
    }

def _get_agent_overrides():
    return _get_agents_config().get("agents", {})


# Fields that are agent constructor params, not LiteLLM kwargs — strip before passing to model_kwargs.
_NON_LITELLM_FIELDS = {
    "model", "strategy",
    # MemGPTAgentBlock params
    "max_heartbeats", "max_context_tokens", "eviction_threshold",
    "memory_pressure_threshold", "response_mode",
    # LLMAgentBlock params
    "max_iterations", "max_tool_calls", "on_max_iterations",
    # Shared
    "debug", "use_shared_router", "loop_detection", "loop_detection_limit",
}

# Agent constructor params that can be overridden per-project via model_params.
_AGENT_PARAM_KEYS = _NON_LITELLM_FIELDS - {"model", "strategy"}


from typing import Union

def get_git_strategy() -> str:
    """Return the git strategy from config.yaml (falls back to agents.yaml for back-compat)."""
    return _APP_CONFIG.get("git_strategy", _get_agents_config().get("git_strategy", "hybrid"))


def get_vector_config() -> dict:
    """Return vector index configuration from config.yaml with defaults."""
    cfg = _APP_CONFIG.get("vector_index", {})
    return {
        "embedding_model": cfg.get("embedding_model", "ollama/nomic-embed-text"),
        "embedding_fallback": cfg.get("embedding_fallback", "sentence-transformers/all-MiniLM-L6-v2"),
        "chunk_size": int(cfg.get("chunk_size", 500)),
        "chunk_overlap": int(cfg.get("chunk_overlap", 50)),
        "top_k": int(cfg.get("top_k", 10)),
    }

def get_project_overview_max_depth() -> int:
    """Return max depth for project overview directory tree from config.yaml with default 3."""
    cfg = _APP_CONFIG.get("project_overview", {})
    return int(cfg.get("max_depth", 3))

def get_agent_max_heartbeats(agent_name: str, default: int) -> Union[int, str]:
    """Return max_heartbeats configured for *agent_name* in agents.yaml (can be 'auto'), or *default*."""
    val = _get_agent_overrides().get(agent_name, {}).get("max_heartbeats", default)
    if val == "auto":
        return "auto"
    return int(val)


def get_agent_heartbeats_scale_factor(agent_name: str, default: float = 2.0) -> float:
    """Return heartbeats_scale_factor: per-agent override > config.yaml global > default."""
    global_scale = float(_APP_CONFIG.get("heartbeats_scale_factor", _get_agents_config().get("heartbeats_scale_factor", default)))
    return float(_get_agent_overrides().get(agent_name, {}).get("heartbeats_scale_factor", global_scale))


def get_agent_debug(agent_name: str, default: bool = False) -> bool:
    """Return debug flag configured for *agent_name* in agents.yaml, or *default*."""
    return bool(_get_agent_overrides().get(agent_name, {}).get("debug", default))


def get_agent_response_mode(agent_name: str, default: str = "last") -> str:
    """Return response_mode for *agent_name*: per-agent override > config.yaml global > default."""
    global_mode = _APP_CONFIG.get("response_mode", _get_agents_config().get("response_mode", default))
    return str(_get_agent_overrides().get(agent_name, {}).get("response_mode", global_mode))


def get_agent_model(agent_name: str, default: str | None = None) -> str:
    """Return the model configured for *agent_name* in agents.yaml, or *default*."""
    override = _get_agent_overrides().get(agent_name, {}).get("model")
    if override:
        return override
    
    cfg = _get_agents_config()
    dyn_default = cfg.get("default", DEFAULT_MODEL)
    return default if default is not None else dyn_default


def get_agent_llm_kwargs(agent_name: str) -> dict:
    """Return merged litellm kwargs for *agent_name*.

    Priority (highest first):
      1. Project-specific model_params (or worker_model_params if worker) (dynamically merged if session exists)
      2. Per-agent override in agents.yaml ``agents.<name>``
      3. Global ``llm_defaults`` in agents.yaml
      4. Hard-coded defaults above

    Non-litellm fields (model, max_heartbeats) are excluded.
    """
    merged = dict(_get_llm_defaults())
    merged.update(_get_agent_overrides().get(agent_name, {}))

    try:
        from .tools import _PROJECT_SESSION
        if _PROJECT_SESSION:
            if agent_name == "worker" and hasattr(_PROJECT_SESSION, "worker_model_params") and _PROJECT_SESSION.worker_model_params:
                clean_params = {k: v for k, v in _PROJECT_SESSION.worker_model_params.items() if v is not None}
                merged.update(clean_params)
            elif hasattr(_PROJECT_SESSION, "model_params") and _PROJECT_SESSION.model_params:
                clean_params = {k: v for k, v in _PROJECT_SESSION.model_params.items() if v is not None}
                merged.update(clean_params)
            
            w_api_base = getattr(_PROJECT_SESSION, "worker_api_base", None) if agent_name == "worker" else None
            w_api_key = getattr(_PROJECT_SESSION, "worker_api_key", None) if agent_name == "worker" else None
            
            if w_api_base:
                merged["api_base"] = w_api_base
            elif getattr(_PROJECT_SESSION, "api_base", None):
                merged["api_base"] = _PROJECT_SESSION.api_base
                
            if w_api_key:
                merged["api_key"] = w_api_key
            elif getattr(_PROJECT_SESSION, "api_key", None):
                merged["api_key"] = _PROJECT_SESSION.api_key
    except Exception:
        pass

    for field in _NON_LITELLM_FIELDS:
        merged.pop(field, None)
    return merged


def resolve_model_for_thinking(model: str, llm_kwargs: dict) -> str:
    """Remap ollama/ → ollama_chat/ when think=True is requested.

    The ollama_chat/ provider uses Ollama's native /api/chat endpoint which
    returns reasoning as a dedicated 'thinking' field per streaming chunk.
    LiteLLM maps this to delta.reasoning_content, enabling real-time thinking
    display via on_thinking per chunk.

    The ollama/ provider uses the OpenAI-compatible endpoint where reasoning
    appears as <think> tags inside delta.content — not in reasoning_content —
    so per-chunk on_thinking never fires.
    """
    if llm_kwargs.get("think") and model.startswith("ollama/"):
        return "ollama_chat/" + model[len("ollama/"):]
    return model


def get_project_agent_params(agent_name: str = "memgpt") -> dict:
    """Return agent constructor overrides stored in the current project's model_params.

    Only keys that belong to _AGENT_PARAM_KEYS are returned; LiteLLM kwargs are excluded.
    None values are filtered out so they don't override defaults with None.
    """
    try:
        from .tools import _PROJECT_SESSION
        if _PROJECT_SESSION:
            if agent_name == "worker" and hasattr(_PROJECT_SESSION, "worker_model_params") and _PROJECT_SESSION.worker_model_params:
                return {k: v for k, v in _PROJECT_SESSION.worker_model_params.items() if k in _AGENT_PARAM_KEYS and v is not None}
            elif hasattr(_PROJECT_SESSION, "model_params") and _PROJECT_SESSION.model_params:
                return {k: v for k, v in _PROJECT_SESSION.model_params.items() if k in _AGENT_PARAM_KEYS and v is not None}
    except Exception:
        pass
    return {}


# Maximum retry attempts for a failing subplan step
DEFAULT_MAX_RETRIES = 3

# MemGPT heartbeat budget per planning turn
DEFAULT_MAX_HEARTBEATS = 15

# SQLite database file for session persistence
DEFAULT_DB_PATH = os.path.join(
    get_opalatex_home(), "sessions.db"
)

# Execution mode: "auto" | "plan" | "edit"
DEFAULT_MODE = "plan"

def _get_system_lang() -> str:
    env_lang = os.getenv("OPALATEX_LANG")
    if env_lang in ("en", "pt"):
        return env_lang
        
    try:
        for var in ("LC_ALL", "LC_CTYPE", "LANG"):
            val = os.getenv(var)
            if val and len(val) >= 2:
                lang_code = val[:2].lower()
                if lang_code in ("en", "pt"):
                    return lang_code
                    
        import locale
        loc, _ = locale.getdefaultlocale()
        if loc and len(loc) >= 2:
            lang_code = loc[:2].lower()
            if lang_code in ("en", "pt"):
                return lang_code
    except Exception:
        pass
        
    return "en"

# Default Language
DEFAULT_LANG = _get_system_lang()

# Default litellm kwargs applied to all local model calls (kept for back-compat)
LITELLM_DEFAULTS: dict = {"num_ctx": _get_llm_defaults()["num_ctx"]}

# Sensitive operations that require user approval in "edit" mode
SENSITIVE_OPS = {
    "write_file", "delete_file", "run_shell",
    "send_network_request", "create_user", "delete_user",
}

# ─── Debug Logging ────────────────────────────────────────────────────────────

# Shared run logger — set by setup_debug_logging(), used by terminal.py debug_* funcs.
_RUN_LOGGER: "logging.Logger | None" = None


def get_run_logger():
    return _RUN_LOGGER


def setup_debug_logging():
    """Enable full debug logging for a run.

    - Creates a timestamped log file: ~/.opalatex/logs/run_<timestamp>.log
    - Logs every litellm call (full prompt + response) via success/failure callbacks.
    - Enables workflow step logs (oracle outputs, worker starts/results) to the same file.
    - Sets OPALATEX_WORKFLOW_DEBUG=1 so terminal.py debug_* functions also fire.
    - Prints the log file path so the user knows where to look.
    """
    import litellm
    import logging
    from datetime import datetime

    global _RUN_LOGGER

    log_dir = os.path.join(get_opalatex_home(), "logs")
    os.makedirs(log_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(log_dir, f"run_{timestamp}.log")

    logger = logging.getLogger(f"opalatex.run.{timestamp}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(fh)

    _RUN_LOGGER = logger

    # Enable workflow debug output in terminal.py (oracle + worker intermediate steps)
    os.environ["OPALATEX_WORKFLOW_DEBUG"] = "1"

    # litellm verbose → logs raw HTTP-level info to stderr; we capture structured data
    # ourselves via callbacks so we leave litellm's own verbose off to reduce noise.
    litellm.set_verbose = False

    SEP = "=" * 80

    def _llm_callback(kwargs, completion_response, start_time, end_time):
        messages = kwargs.get("messages", [])
        model = kwargs.get("model", "unknown")
        elapsed = (end_time - start_time).total_seconds() if start_time and end_time else 0

        lines = [
            f"\n{SEP}",
            f"[LLM CALL] model={model}  elapsed={elapsed:.2f}s",
            f"{SEP}",
            "--- MESSAGES (input) ---",
        ]
        for msg in messages:
            role = msg.get("role", "?").upper()
            content = msg.get("content") or ""
            # tool_calls in assistant messages
            tcs = msg.get("tool_calls")
            if tcs:
                content = f"<tool_calls> {tcs}"
            lines.append(f"\n[{role}]\n{content}")

        lines.append("\n--- RESPONSE (output) ---")
        if completion_response:
            try:
                choice = completion_response.choices[0]
                msg_out = choice.message
                if msg_out.content:
                    lines.append(msg_out.content)
                if getattr(msg_out, "tool_calls", None):
                    lines.append(f"<tool_calls> {msg_out.tool_calls}")
            except Exception:
                lines.append(str(completion_response))
        else:
            lines.append("(no response)")

        lines.append(SEP)
        logger.debug("\n".join(lines))
        for handler in logger.handlers:
            handler.flush()

    litellm.success_callback = [_llm_callback]
    litellm.failure_callback = [_llm_callback]

    print(f"[debug] Full run log → {log_file}")
    return log_file


