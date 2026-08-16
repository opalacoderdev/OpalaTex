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
        "think": True,
        "max_heartbeats": 20,
        "debug": False,
    },
    "landscape_planner": {
        "num_ctx": 8192,
    },
    "refinement_agent": {
        "num_ctx": 8192,
    },
    "orchestrator": {
        "num_ctx": 16384,
        "think": True,
        "max_heartbeats": 20,
        "debug": False,
        "strategy": "workflow",
    },
    "worker": {
        "num_ctx": 16384,
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
WORKER_MODEL = _initial_cfg.get("worker", _initial_cfg.get("alternative", "gemini/gemini-3.5-flash-lite"))
DEFAULT_LITELLM_TIMEOUT_SECONDS = 600.0


def _get_llm_defaults():
    cfg = _get_agents_config()
    return {
        "temperature": 0.7,
        "num_ctx": 8192,
        "timeout": DEFAULT_LITELLM_TIMEOUT_SECONDS,
        "request_timeout": DEFAULT_LITELLM_TIMEOUT_SECONDS,
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

# Internal OpalaTex feature flags stored with model_params, but never accepted by LiteLLM.
_INTERNAL_MODEL_PARAM_FIELDS = {
    "force_vision",
    "pdf_truncate",
    "pdf_truncate_pct",
    "supports_thinking",
}

# LiteLLM passes these fields through to providers that do not understand them.
# They are useful for local Ollama models, but OpenAI-compatible endpoints reject
# them as unknown request parameters.
_LOCAL_ONLY_LITELLM_FIELDS = {
    "num_ctx",
    "top_k",
    "min_p",
    "repetition_penalty",
    "think",
}

_OLLAMA_COMPAT_LITELLM_FIELDS = _LOCAL_ONLY_LITELLM_FIELDS | {
    "presence_penalty",
}

_COMMON_SAMPLING_LITELLM_FIELDS = {
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
}

_LITELLM_TRANSPORT_FIELDS = {
    "api_key",
    "api_base",
    "api_version",
    "base_url",
    "custom_llm_provider",
    "organization",
    "default_headers",
    "extra_headers",
    "timeout",
    "request_timeout",
    "force_timeout",
    "stream_timeout",
    "max_retries",
    "drop_params",
    "allowed_openai_params",
    "additional_drop_params",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
}

# Agent constructor params that can be overridden per-project via model_params.
_AGENT_PARAM_KEYS = _NON_LITELLM_FIELDS - {"model", "strategy"}


from typing import Union

LOCAL_MODEL_CONTEXT_TOKENS = 8192
CLOUD_MODEL_CONTEXT_TOKENS = 65536
OLLAMA_CLOUD_API_BASE = "https://ollama.com"


def is_ollama_cloud_model(model: str | None) -> bool:
    """Return True for Ollama model ids that are meant to run on Ollama Cloud."""
    model_id = str(model or "").strip().lower()
    if "/" not in model_id:
        return False
    provider, model_name = model_id.split("/", 1)
    if provider not in {"ollama", "ollama_chat"}:
        return False
    return model_name.endswith(":cloud") or model_name.endswith("-cloud")


def is_local_model(model: str | None, api_base: str | None = "") -> bool:
    """Return True when a model should use local-model context defaults."""
    model_id = str(model or "")
    api_base_value = str(api_base or "").strip().lower()

    provider = model_id.split("/", 1)[0].lower() if "/" in model_id else ""
    if provider not in {"ollama", "ollama_chat"}:
        return False

    if is_ollama_cloud_model(model_id):
        return False

    if not api_base_value:
        return True
    if "localhost" in api_base_value or "127.0.0.1" in api_base_value or "[::1]" in api_base_value:
        return True
    if api_base_value.startswith("http://0.0.0.0") or api_base_value.startswith("http://::1"):
        return True
    return False


def normalize_ollama_api_base_for_litellm(model: str | None, api_base: str | None) -> str:
    """Return the Ollama root URL expected by LiteLLM native Ollama providers."""
    value = str(api_base or "").strip()
    model_id = str(model or "").lower()
    if not value or not (
        model_id.startswith("ollama/") or model_id.startswith("ollama_chat/")
    ):
        return value
    if value.endswith("/v1"):
        return value[:-3]
    if value.endswith("/v1/"):
        return value[:-4]
    return value


def default_num_ctx_for_model(model: str | None, api_base: str | None = "") -> int:
    """Return the predictable default context window for a model selection."""
    return LOCAL_MODEL_CONTEXT_TOKENS if is_local_model(model, api_base) else CLOUD_MODEL_CONTEXT_TOKENS


def apply_default_num_ctx(params: dict | None, model: str | None, api_base: str | None = "") -> dict:
    """Return params with a default num_ctx when the user did not set one."""
    result = dict(params or {})
    if result.get("num_ctx") in (None, ""):
        result["num_ctx"] = default_num_ctx_for_model(model, api_base)
    return result


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


DEFAULT_WORKSPACE_HIDDEN_FILE_EXTENSIONS = [
    ".aux",
    ".log",
    ".out",
    ".toc",
    ".lof",
    ".lot",
    ".fls",
    ".fdb_latexmk",
    ".synctex",
    ".synctex.gz",
    ".bbl",
    ".blg",
    ".bcf",
    ".run.xml",
    ".nav",
    ".snm",
    ".vrb",
    ".xdv",
    ".dvi",
    ".idx",
    ".ilg",
    ".ind",
    ".acn",
    ".acr",
    ".alg",
    ".glg",
    ".glo",
    ".gls",
    ".ist",
    ".lol",
    ".loa",
    ".maf",
    ".mtc",
    ".mtc0",
]


def get_workspace_hidden_file_extensions() -> list[str]:
    """Return file extensions hidden from the workspace tree by default."""
    cfg = _APP_CONFIG.get("workspace_files", {})
    raw_extensions = cfg.get("hidden_file_extensions", DEFAULT_WORKSPACE_HIDDEN_FILE_EXTENSIONS)
    if not isinstance(raw_extensions, list):
        return list(DEFAULT_WORKSPACE_HIDDEN_FILE_EXTENSIONS)

    normalized: list[str] = []
    seen = set()
    for value in raw_extensions:
        ext = str(value or "").strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = "." + ext
        if ext not in seen:
            normalized.append(ext)
            seen.add(ext)
    return normalized

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
    model = default if default is not None else dyn_default
    return model


def get_agent_llm_kwargs(agent_name: str, model_override: str | None = None) -> dict:
    """Return merged litellm kwargs for *agent_name*.

    Priority (highest first):
      1. Project-specific model_params (or worker_model_params if worker) (dynamically merged if session exists)
      2. Per-agent override in agents.yaml ``agents.<name>``
      3. Global ``llm_defaults`` in agents.yaml
      4. Hard-coded defaults above

    Non-litellm fields (model, max_heartbeats) are excluded. When
    ``model_override`` is provided, its catalog entry supplies the provider
    credentials and capabilities instead of resolving a model for the agent
    role. This is used by UI features that must follow the model currently
    selected for the chat.
    """
    merged = dict(_get_llm_defaults())
    merged.update(_get_agent_overrides().get(agent_name, {}))

    try:
        from .tools import _PROJECT_SESSION
        if _PROJECT_SESSION:
            explicit_worker_model = (
                agent_name == "worker"
                and bool(getattr(_PROJECT_SESSION, "worker_model", ""))
            )
            if agent_name == "worker" and hasattr(_PROJECT_SESSION, "worker_model_params") and _PROJECT_SESSION.worker_model_params:
                clean_params = {k: v for k, v in _PROJECT_SESSION.worker_model_params.items() if v is not None}
                merged.update(clean_params)
            elif hasattr(_PROJECT_SESSION, "model_params") and _PROJECT_SESSION.model_params:
                clean_params = {k: v for k, v in _PROJECT_SESSION.model_params.items() if v is not None}
                merged.update(clean_params)
            
    except Exception:
        pass

    session_model = None
    explicit_project_worker = False
    try:
        from .tools import _PROJECT_SESSION
        if _PROJECT_SESSION:
            if agent_name == "worker" and hasattr(_PROJECT_SESSION, "worker_model") and _PROJECT_SESSION.worker_model:
                session_model = _PROJECT_SESSION.worker_model
                explicit_project_worker = True
            elif hasattr(_PROJECT_SESSION, "model") and _PROJECT_SESSION.model:
                session_model = _PROJECT_SESSION.model
    except Exception:
        pass

    resolved_model = (
        str(model_override).strip()
        if model_override and str(model_override).strip()
        else get_agent_model(agent_name, default=session_model)
    )
    from opalatex.models_store import resolve_runtime_model_id

    runtime_model = resolve_runtime_model_id(resolved_model)

    store_api_base = None
    store_api_key = None
    store_supports_thinking = False
    session_api_base = None
    session_api_key = None
    try:
        from opalatex.models_store import get_model
        store_model = get_model(resolved_model)
        if store_model:
            store_api_base = store_model.get("api_base")
            store_api_key = store_model.get("api_key")
            store_supports_thinking = bool(store_model.get("supports_thinking", False))
    except Exception:
        pass

    try:
        from .tools import _PROJECT_SESSION
        if _PROJECT_SESSION:
            if agent_name == "worker":
                session_api_base = getattr(_PROJECT_SESSION, "worker_api_base", None)
                session_api_key = getattr(_PROJECT_SESSION, "worker_api_key", None)
                if not explicit_project_worker:
                    session_api_base = session_api_base or getattr(_PROJECT_SESSION, "api_base", None)
                    session_api_key = session_api_key or getattr(_PROJECT_SESSION, "api_key", None)
            else:
                session_api_base = getattr(_PROJECT_SESSION, "api_base", None)
                session_api_key = getattr(_PROJECT_SESSION, "api_key", None)
    except Exception:
        pass
    if store_api_base:
        merged["api_base"] = normalize_ollama_api_base_for_litellm(
            runtime_model,
            store_api_base,
        )
    if store_api_key:
        merged["api_key"] = store_api_key
    if session_api_base:
        merged["api_base"] = normalize_ollama_api_base_for_litellm(
            runtime_model,
            session_api_base,
        )
    if session_api_key:
        merged["api_key"] = session_api_key

    if is_ollama_cloud_model(runtime_model):
        merged.setdefault("api_base", OLLAMA_CLOUD_API_BASE)
        merged.setdefault("api_key", os.getenv("OLLAMA_API_KEY", ""))
        merged.setdefault("timeout", DEFAULT_LITELLM_TIMEOUT_SECONDS)
        merged.setdefault("request_timeout", DEFAULT_LITELLM_TIMEOUT_SECONDS)

    for field in _NON_LITELLM_FIELDS | _INTERNAL_MODEL_PARAM_FIELDS:
        merged.pop(field, None)
    merged.setdefault("think", False)
    if not store_supports_thinking:
        merged.pop("think", None)
    return sanitize_litellm_kwargs_for_model(runtime_model, merged)


def model_supports_thinking(model: str | None) -> bool:
    """Return True only when the model store explicitly enables thinking."""
    try:
        from opalatex.models_store import get_model
        store_model = get_model(str(model or ""))
        return bool(store_model and store_model.get("supports_thinking", False))
    except Exception:
        return False


def model_requires_single_system_message(model: str | None) -> bool:
    """Return True only when the model store explicitly flags this requirement.

    Some provider chat templates (observed with an Ollama-served qwen3.8)
    reject a request outright unless exactly one ``system``-role message is
    present as the very first message. This is a per-model catalog capability,
    not a provider-wide rule, since most models tolerate multiple/positioned
    system messages fine.
    """
    try:
        from opalatex.models_store import get_model
        store_model = get_model(str(model or ""))
        return bool(store_model and store_model.get("requires_single_system_message", False))
    except Exception:
        return False


def sanitize_litellm_kwargs_for_model(model: str, kwargs: dict) -> dict:
    """Remove provider-incompatible kwargs before passing them to LiteLLM."""
    cleaned = dict(kwargs or {})
    for field in _NON_LITELLM_FIELDS | _INTERNAL_MODEL_PARAM_FIELDS:
        cleaned.pop(field, None)

    provider = ""
    if model and "/" in model:
        provider = model.split("/", 1)[0].lower()

    custom_provider = cleaned.get("custom_llm_provider")
    supported_params = None
    try:
        import litellm
        supported_params = litellm.get_supported_openai_params(
            model=model,
            custom_llm_provider=custom_provider,
        )
    except Exception:
        supported_params = None

    if supported_params:
        allowed = set(supported_params) | _LITELLM_TRANSPORT_FIELDS
        if provider in {"ollama", "ollama_chat"}:
            allowed |= _OLLAMA_COMPAT_LITELLM_FIELDS
        if provider == "gemini":
            allowed |= _COMMON_SAMPLING_LITELLM_FIELDS
        cleaned = {key: value for key, value in cleaned.items() if key in allowed}
    elif provider not in {"ollama", "ollama_chat"}:
        for field in _LOCAL_ONLY_LITELLM_FIELDS:
            cleaned.pop(field, None)

    if provider not in {"ollama", "ollama_chat"} and cleaned.get("reasoning_effort") in {"", "none", None}:
        cleaned.pop("reasoning_effort", None)

    # LiteLLM bridges OpenAI GPT-5.4+ chat-completion requests to the Responses
    # API when tools and reasoning_effort are both present. AgenticBlocks expects
    # Chat Completions tool-call adjacency, so that bridge can leave Responses
    # waiting for function_call_output items and produce "No tool output found".
    # Users can still opt into Responses explicitly with openai/responses/<model>.
    if _is_openai_gpt5_chat_model(model, provider, custom_provider):
        cleaned.pop("reasoning_effort", None)
        cleaned.pop("reasoning_summary", None)
        cleaned.pop("reasoningSummary", None)
        _strip_openai_gpt5_default_only_sampling_params(cleaned)

    # Gemini 3+ deprecates request-level sampling params (temperature, top_p,
    # top_k) — Google recommends moving sampling guidance into the system
    # instructions. Only strip when using the gemini/vertex_ai provider
    # directly (NOT when routed through an OpenAI-compatible proxy, which
    # already discards sampling params via custom_llm_provider=openai).
    if _is_gemini3_direct_model(model, provider, custom_provider):
        _strip_gemini3_sampling_params(cleaned)

    # Ask LiteLLM to drop provider-unsupported optional params instead of
    # surfacing them as BadRequest errors on OpenAI-compatible endpoints.
    cleaned.setdefault("drop_params", True)

    return cleaned


def _is_openai_gpt5_chat_model(model: str, provider: str, custom_provider: str | None) -> bool:
    """Return True for OpenAI GPT-5 chat models that must avoid Responses bridge."""
    if provider != "openai" and custom_provider != "openai":
        return False
    model_name = model.split("/", 1)[1] if "/" in model else model
    if model_name.startswith("responses/"):
        return False
    if not model_name.startswith("gpt-5."):
        return False
    version = model_name[len("gpt-5."):]
    prefix = version.split("-", 1)[0]
    try:
        return float(prefix) >= 4.0
    except ValueError:
        return False


def _strip_openai_gpt5_default_only_sampling_params(cleaned: dict) -> None:
    """Remove sampling knobs that GPT-5 chat models only accept at defaults."""
    for field in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
        cleaned.pop(field, None)


def _is_gemini3_direct_model(model: str, provider: str, custom_provider: str | None) -> bool:
    """Return True for Gemini 3+ models reached via the gemini/vertex_ai provider.

    Requests routed through an OpenAI-compatible proxy (custom_llm_provider=openai)
    are excluded here — such proxies already discard sampling params, and the
    DeprecationWarning is only emitted by LiteLLM's vertex_and_google_ai_studio_gemini
    module.
    """
    if custom_provider == "openai":
        return False
    if provider not in {"gemini", "vertex_ai", "vertex"}:
        return False
    model_name = model.split("/", 1)[1] if "/" in model else model
    # Match gemini-3, gemini-3.1, gemini-3-pro-preview, etc. (not gemini-2.5).
    return model_name.lower().startswith("gemini-3")


def _strip_gemini3_sampling_params(cleaned: dict) -> None:
    """Remove sampling params deprecated for Gemini 3+.

    Google's guidance is to move sampling into the system instructions instead
    of sending temperature/top_p/top_k as request fields. We simply drop them
    (Gemini 3 defaults are reasonable); the system_prompt is left untouched.
    """
    for field in ("temperature", "top_p", "top_k"):
        cleaned.pop(field, None)


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
    selected_model = model
    from opalatex.models_store import resolve_runtime_model_id

    model = resolve_runtime_model_id(model)
    if not model_supports_thinking(selected_model):
        llm_kwargs.pop("think", None)
        llm_kwargs.pop("reasoning_effort", None)
    if model.startswith("ollama/") and (llm_kwargs.get("think") or llm_kwargs.get("reasoning_effort")):
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

    return log_file


