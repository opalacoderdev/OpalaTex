import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List
from urllib import error as urllib_error
from urllib import request as urllib_request

from .config import DEFAULT_DB_PATH, get_opalatex_home
from .extensions import get_extension_manager

_DEFAULT_MODELS_STORE_PATH = Path(get_opalatex_home()) / "models.json"
_MODELS_STORE_PATH = _DEFAULT_MODELS_STORE_PATH
_MODELS_TABLE = "global_models"

_DEFAULT_MODELS: List[Dict[str, Any]] = []
_LOCAL_OLLAMA_API_BASE = "http://localhost:11434/v1"
_LOCAL_OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"


class LocalOllamaNotInstalledError(RuntimeError):
    """Raised when local Ollama discovery is requested without Ollama installed."""


class LocalOllamaUnavailableError(RuntimeError):
    """Raised when Ollama is installed but its local API cannot be reached."""

def normalize_model_entry(model: Dict[str, Any]) -> Dict[str, Any]:
    """Return a model-store entry with stable optional capability defaults."""
    entry = dict(model or {})
    entry["id"] = str(entry.get("id", "")).strip()
    entry["provider"] = str(entry.get("provider", "")).strip()
    entry["name"] = str(entry.get("name", "")).strip()
    entry["api_key"] = str(entry.get("api_key", "") or "")
    entry["api_base"] = str(entry.get("api_base", "") or "")
    entry["supports_thinking"] = bool(entry.get("supports_thinking", False))
    return entry


def _connect() -> sqlite3.Connection:
    db_path = (
        Path(DEFAULT_DB_PATH)
        if Path(_MODELS_STORE_PATH) == _DEFAULT_MODELS_STORE_PATH
        else Path(_MODELS_STORE_PATH).with_suffix(".sqlite3")
    )
    if str(db_path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_MODELS_TABLE} (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            api_base TEXT NOT NULL DEFAULT '',
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            extra_json TEXT NOT NULL DEFAULT '{{}}',
            sort_order INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    return conn


def _row_to_model(row: sqlite3.Row) -> Dict[str, Any]:
    extra: Dict[str, Any] = {}
    try:
        extra = json.loads(row["extra_json"] or "{}")
    except Exception:
        extra = {}
    return normalize_model_entry({
        **extra,
        "id": row["id"],
        "provider": row["provider"],
        "name": row["name"],
        "api_key": row["api_key"],
        "api_base": row["api_base"],
        "supports_thinking": bool(row["supports_thinking"]),
    })


def _model_extra_json(model: Dict[str, Any]) -> str:
    known = {"id", "provider", "name", "api_key", "api_base", "supports_thinking", "previous_id"}
    extra = {k: v for k, v in model.items() if k not in known}
    return json.dumps(extra, ensure_ascii=False)


def _load_legacy_json_models() -> List[Dict[str, Any]]:
    try:
        if _MODELS_STORE_PATH.exists():
            with open(_MODELS_STORE_PATH, "r", encoding="utf-8") as f:
                models = json.load(f)
            if isinstance(models, list):
                return [normalize_model_entry(m) for m in models if isinstance(m, dict)]
    except Exception:
        pass
    return []

def load_models() -> List[Dict[str, Any]]:
    """Load models from the global SQLite model store or import legacy entries once."""
    loaded_defaults = False
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM {_MODELS_TABLE} ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        models = [_row_to_model(row) for row in rows]

    if len(models) == 0:
        legacy_models = _load_legacy_json_models()
        models = legacy_models or [normalize_model_entry(m) for m in _DEFAULT_MODELS]
        loaded_defaults = True
        
    # Inject cloud models if provided by cloud extension, or filter them out if empty
    ext_mgr = get_extension_manager()
    managed_cloud_models = ext_mgr.cloud.get_cloud_models()
    if managed_cloud_models:
        existing_ids = {m.get("id"): m for m in models if isinstance(m, dict)}
        insert_at = 0
        for cloud_model in managed_cloud_models:
            cloud_id = cloud_model["id"]
            if cloud_id not in existing_ids:
                models.insert(insert_at, normalize_model_entry(cloud_model))
                insert_at += 1
                existing_ids[cloud_id] = models[insert_at - 1]
                loaded_defaults = True
            else:
                existing_entry = existing_ids[cloud_id]
                if existing_entry.get("name") != cloud_model["name"] or existing_entry.get("provider") != cloud_model["provider"]:
                    existing_entry["name"] = cloud_model["name"]
                    existing_entry["provider"] = cloud_model["provider"]
                    loaded_defaults = True
                if "supports_thinking" not in existing_entry:
                    existing_entry["supports_thinking"] = False
                    loaded_defaults = True
    else:
        filtered = [
            m for m in models
            if isinstance(m, dict)
            and str(m.get("provider", "")).lower() not in ("opalatex", "opalatex_cloud")
            and not str(m.get("id", "")).lower().startswith("opalatex")
        ]
        if len(filtered) != len(models):
            models = filtered
            loaded_defaults = True
        
    if loaded_defaults:
        save_models(models)
        
    return models



def save_models(models: List[Dict[str, Any]]) -> None:
    """Save models list to the global SQLite model store."""
    with _connect() as conn:
        conn.execute(f"DELETE FROM {_MODELS_TABLE}")
        for index, raw_model in enumerate(models or []):
            model = normalize_model_entry(raw_model)
            if not model.get("id"):
                continue
            conn.execute(
                f"""
                INSERT INTO {_MODELS_TABLE}
                (id, provider, name, api_key, api_base, supports_thinking, extra_json, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    model["id"],
                    model.get("provider", ""),
                    model.get("name", ""),
                    model.get("api_key", ""),
                    model.get("api_base", ""),
                    int(bool(model.get("supports_thinking", False))),
                    _model_extra_json(model),
                    index,
                ),
            )


def load_local_ollama_models() -> List[Dict[str, Any]]:
    """Import unconfigured models exposed by the local Ollama API."""
    from .ollama_manager import check_ollama_status

    if not check_ollama_status().get("installed"):
        raise LocalOllamaNotInstalledError("Ollama is not installed")

    try:
        request = urllib_request.Request(_LOCAL_OLLAMA_TAGS_URL, method="GET")
        with urllib_request.urlopen(request, timeout=2.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib_error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise LocalOllamaUnavailableError("The local Ollama API is unavailable") from exc

    remote_models = payload.get("models", []) if isinstance(payload, dict) else []
    if not isinstance(remote_models, list):
        raise LocalOllamaUnavailableError("The local Ollama API returned an invalid model list")

    configured_models = load_models()
    configured_names = {
        model.get("name", "")
        for model in configured_models
        if model.get("provider") == "ollama"
    }
    configured_ids = {model.get("id", "") for model in configured_models}
    additions: List[Dict[str, Any]] = []

    for remote_model in remote_models:
        model_name = str(remote_model.get("name", "") if isinstance(remote_model, dict) else "").strip()
        if not model_name or model_name in configured_names:
            continue

        model_id = f"ollama/{model_name}"
        suffix = 2
        while model_id in configured_ids:
            model_id = f"ollama/{model_name}#local-{suffix}"
            suffix += 1

        additions.append(normalize_model_entry({
            "id": model_id,
            "provider": "ollama",
            "name": model_name,
            "api_key": "",
            "api_base": _LOCAL_OLLAMA_API_BASE,
        }))
        configured_names.add(model_name)
        configured_ids.add(model_id)

    if additions:
        save_models([*configured_models, *additions])

    return additions

def get_model(model_id: str) -> Dict[str, Any] | None:
    """Get a specific model by ID."""
    models = load_models()
    for m in models:
        if m.get("id") == model_id:
            return m
    return None

def resolve_runtime_model_id(model_id: str | None) -> str:
    """Return the provider/model identifier used by LiteLLM for a stored entry.

    Model-store IDs identify a configuration entry and may include a suffix when
    the same provider/model is configured against multiple API base URLs.
    LiteLLM must always receive the original ``provider/name`` identifier.
    """
    configured_model = get_model(str(model_id or ""))
    if configured_model:
        provider = configured_model.get("provider", "")
        name = configured_model.get("name", "")
        if provider and name:
            return f"{provider}/{name}"
    return str(model_id or "")


def _has_duplicate_configuration(
    models: List[Dict[str, Any]],
    model_data: Dict[str, Any],
    previous_id: str | None,
) -> bool:
    """Return whether the provider, model name, and API base URL already exist."""
    provider = model_data["provider"]
    name = model_data["name"]
    api_base = model_data["api_base"]
    return any(
        model.get("id") != previous_id
        and model.get("provider") == provider
        and model.get("name") == name
        and model.get("api_base", "") == api_base
        for model in models
    )


def add_or_update_model(model_data: Dict[str, Any]) -> None:
    """Add a new model or update an existing one by ID.

    When editing a model whose ID changed, callers can pass ``previous_id`` to
    replace the old entry instead of appending a duplicate under the new ID.
    """
    if "id" not in model_data:
        raise ValueError("Model data must contain an 'id' field")
        
    models = load_models()
    model_data = normalize_model_entry(model_data)
    previous_id = model_data.pop("previous_id", None)
    model_id = model_data["id"]

    if _has_duplicate_configuration(models, model_data, previous_id):
        raise ValueError(
            "A model with this provider, name, and API base URL already exists"
        )

    if previous_id and previous_id != model_id:
        for m in models:
            if m.get("id") == model_id:
                raise ValueError(f"Model '{model_id}' already exists")
    
    updated = False
    for i, m in enumerate(models):
        if m.get("id") == (previous_id or model_id):
            models[i] = model_data
            updated = True
            break
            
    if not updated:
        models.append(model_data)
        
    save_models(models)

def delete_model(model_id: str) -> bool:
    """Delete a model by ID. Returns True if deleted, False if not found."""
    models = load_models()
    initial_length = len(models)
    
    models = [m for m in models if m.get("id") != model_id]
    
    if len(models) < initial_length:
        save_models(models)
        return True
    return False
