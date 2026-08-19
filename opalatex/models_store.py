import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request

from .config import DEFAULT_DB_PATH, get_opalatex_home

_DEFAULT_MODELS_STORE_PATH = Path(get_opalatex_home()) / "models.json"
_MODELS_STORE_PATH = _DEFAULT_MODELS_STORE_PATH
_MODELS_TABLE = "global_models"
_CONNECTIONS_TABLE = "provider_connections"

_DEFAULT_MODELS: List[Dict[str, Any]] = []
_LOCAL_OLLAMA_API_BASE = "http://localhost:11434/v1"
_LOCAL_OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
_LOCAL_OLLAMA_CONNECTION_ID = "ollama-local"


class LocalOllamaNotInstalledError(RuntimeError):
    """Raised when local Ollama discovery is requested without Ollama installed."""


class LocalOllamaUnavailableError(RuntimeError):
    """Raised when Ollama is installed but its local API cannot be reached."""


def normalize_model_entry(model: Dict[str, Any]) -> Dict[str, Any]:
    """Return a model-store entry with stable optional capability defaults."""
    entry = dict(model or {})
    entry["id"] = str(entry.get("id", "")).strip()
    entry["provider"] = str(entry.get("provider", "") or "").strip()
    entry["name"] = str(entry.get("name", "")).strip()
    entry["api_key"] = str(entry.get("api_key", "") or "")
    entry["api_base"] = str(entry.get("api_base", "") or "")
    entry["supports_thinking"] = bool(entry.get("supports_thinking", False))
    entry["requires_single_system_message"] = bool(entry.get("requires_single_system_message", False))
    _profile = str(entry.get("prompt_profile", "") or "full").strip().lower()
    entry["prompt_profile"] = _profile if _profile in ("full", "light") else "full"
    # Orthogonal to prompt_profile on purpose: the profile says how verbose this
    # model's prompt should be, the policy says whether it may touch files when it
    # runs as the chat orchestrator. Keeping them in separate fields is what makes
    # "light prompt + delegate writes" -- the natural setting for a small local
    # model -- expressible at all. Only consulted for the orchestrator role; a
    # worker has no run_skill and therefore nothing to delegate to.
    _policy = str(entry.get("orchestrator_policy", "") or "direct").strip().lower()
    entry["orchestrator_policy"] = _policy if _policy in ("direct", "delegate") else "direct"
    _num_ctx = entry.get("num_ctx")
    try:
        entry["num_ctx"] = int(_num_ctx) if _num_ctx not in (None, "") else None
    except (TypeError, ValueError):
        entry["num_ctx"] = None
    entry["connection_id"] = str(entry.get("connection_id", "") or "")
    entry["connection_label"] = str(entry.get("connection_label", "") or "")
    return entry


def normalize_connection_entry(connection: Dict[str, Any]) -> Dict[str, Any]:
    """Return a provider-connection entry with stable field defaults."""
    entry = dict(connection or {})
    entry["id"] = str(entry.get("id", "")).strip()
    entry["label"] = str(entry.get("label", "") or "").strip()
    entry["provider"] = str(entry.get("provider", "") or "").strip()
    entry["api_key"] = str(entry.get("api_key", "") or "")
    entry["api_base"] = str(entry.get("api_base", "") or "")
    return entry


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return slug or "connection"


def _generate_connection_id(conn: sqlite3.Connection, base_label: str) -> str:
    base = _slugify(base_label)
    existing_ids = {
        row["id"] for row in conn.execute(f"SELECT id FROM {_CONNECTIONS_TABLE}").fetchall()
    }
    candidate = base
    suffix = 2
    while candidate in existing_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _migrate_legacy_rows(conn: sqlite3.Connection) -> None:
    """Backfill `connection_id` for rows saved before provider connections existed.

    Idempotent and additive: only touches rows where `connection_id` is still
    empty, so a crash mid-migration just leaves those rows for the next call
    to pick up. Existing provider/api_key/api_base columns on `global_models`
    are never dropped, so an unmigrated row still resolves credentials
    correctly through `_row_to_model`'s legacy-column fallback in the
    meantime.
    """
    rows = conn.execute(
        f"SELECT id, provider, api_key, api_base FROM {_MODELS_TABLE} WHERE connection_id = ''"
    ).fetchall()
    if not rows:
        return

    existing_connections = conn.execute(
        f"SELECT id, label, provider, api_key, api_base FROM {_CONNECTIONS_TABLE}"
    ).fetchall()
    lookup: Dict[Tuple[str, str, str], str] = {
        (row["provider"] or "", row["api_key"] or "", row["api_base"] or ""): row["id"]
        for row in existing_connections
    }
    existing_ids = {row["id"] for row in existing_connections}
    provider_label_counts: Dict[str, int] = {}
    for row in existing_connections:
        provider_label_counts[row["provider"] or ""] = provider_label_counts.get(row["provider"] or "", 0) + 1

    # Legacy local-Ollama rows must land on the same well-known connection id
    # that `load_local_ollama_models` looks up, or re-running discovery after
    # an upgrade would duplicate every already-configured local model instead
    # of recognizing it as already present.
    local_ollama_key = ("ollama", "", _LOCAL_OLLAMA_API_BASE)

    for row in rows:
        key = (row["provider"] or "", row["api_key"] or "", row["api_base"] or "")
        connection_id = lookup.get(key)
        if connection_id is None:
            if key == local_ollama_key:
                connection_id = _LOCAL_OLLAMA_CONNECTION_ID
                label = "Local Ollama"
            else:
                provider = key[0]
                count = provider_label_counts.get(provider, 0) + 1
                provider_label_counts[provider] = count
                label = provider if count == 1 else f"{provider} ({count})"
                connection_id = _generate_connection_id(conn, label or "connection")
            if connection_id not in existing_ids:
                conn.execute(
                    f"""
                    INSERT INTO {_CONNECTIONS_TABLE} (id, label, provider, api_key, api_base, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (connection_id, label, key[0], key[1], key[2], 0),
                )
                existing_ids.add(connection_id)
            lookup[key] = connection_id
        conn.execute(
            f"UPDATE {_MODELS_TABLE} SET connection_id = ? WHERE id = ?",
            (connection_id, row["id"]),
        )
    conn.commit()


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
        CREATE TABLE IF NOT EXISTS {_CONNECTIONS_TABLE} (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            api_base TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_MODELS_TABLE} (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            api_base TEXT NOT NULL DEFAULT '',
            connection_id TEXT NOT NULL DEFAULT '',
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            requires_single_system_message INTEGER NOT NULL DEFAULT 0,
            prompt_profile TEXT NOT NULL DEFAULT 'full',
            orchestrator_policy TEXT NOT NULL DEFAULT 'direct',
            num_ctx INTEGER,
            extra_json TEXT NOT NULL DEFAULT '{{}}',
            sort_order INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    # Additive migrations for a `global_models` table created before these
    # columns existed. Harmlessly no-op on a fresh table (the CREATE TABLE
    # above already includes them).
    try:
        conn.execute(f"ALTER TABLE {_MODELS_TABLE} ADD COLUMN connection_id TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute(f"ALTER TABLE {_MODELS_TABLE} ADD COLUMN requires_single_system_message INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute(f"ALTER TABLE {_MODELS_TABLE} ADD COLUMN prompt_profile TEXT NOT NULL DEFAULT 'full'")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute(f"ALTER TABLE {_MODELS_TABLE} ADD COLUMN orchestrator_policy TEXT NOT NULL DEFAULT 'direct'")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute(f"ALTER TABLE {_MODELS_TABLE} ADD COLUMN num_ctx INTEGER")
    except sqlite3.OperationalError:
        pass
    _migrate_legacy_rows(conn)
    return conn


def _row_to_model(row: sqlite3.Row) -> Dict[str, Any]:
    extra: Dict[str, Any] = {}
    try:
        extra = json.loads(row["extra_json"] or "{}")
    except Exception:
        extra = {}
    has_connection = bool(row["connection_id"]) and row["conn_provider"] is not None
    provider = row["conn_provider"] if has_connection else row["legacy_provider"]
    api_key = row["conn_api_key"] if has_connection else row["legacy_api_key"]
    api_base = row["conn_api_base"] if has_connection else row["legacy_api_base"]
    return normalize_model_entry({
        **extra,
        "id": row["id"],
        "provider": provider,
        "name": row["name"],
        "api_key": api_key,
        "api_base": api_base,
        "supports_thinking": bool(row["supports_thinking"]),
        "requires_single_system_message": bool(row["requires_single_system_message"]),
        "prompt_profile": row["prompt_profile"] or "full",
        "orchestrator_policy": row["orchestrator_policy"] or "direct",
        "num_ctx": row["num_ctx"],
        "connection_id": row["connection_id"] or "",
        "connection_label": row["conn_label"] if has_connection else "",
    })


def _model_extra_json(model: Dict[str, Any]) -> str:
    known = {
        "id", "provider", "name", "api_key", "api_base", "supports_thinking",
        "requires_single_system_message", "prompt_profile", "orchestrator_policy",
        "num_ctx", "previous_id",
        "connection_id", "connection_label",
    }
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
            f"""
            SELECT
                gm.id AS id,
                gm.name AS name,
                gm.supports_thinking AS supports_thinking,
                gm.requires_single_system_message AS requires_single_system_message,
                gm.prompt_profile AS prompt_profile,
                gm.orchestrator_policy AS orchestrator_policy,
                gm.num_ctx AS num_ctx,
                gm.extra_json AS extra_json,
                gm.sort_order AS sort_order,
                gm.connection_id AS connection_id,
                gm.provider AS legacy_provider,
                gm.api_key AS legacy_api_key,
                gm.api_base AS legacy_api_base,
                pc.provider AS conn_provider,
                pc.api_key AS conn_api_key,
                pc.api_base AS conn_api_base,
                pc.label AS conn_label
            FROM {_MODELS_TABLE} gm
            LEFT JOIN {_CONNECTIONS_TABLE} pc ON pc.id = gm.connection_id
            ORDER BY gm.sort_order ASC, gm.id ASC
            """
        ).fetchall()
        models = [_row_to_model(row) for row in rows]

    if len(models) == 0:
        legacy_models = _load_legacy_json_models()
        models = legacy_models or [normalize_model_entry(m) for m in _DEFAULT_MODELS]
        loaded_defaults = True

    # Filter out any stray Opala Cloud model entries left over from earlier versions.
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
                (id, provider, name, api_key, api_base, connection_id, supports_thinking, requires_single_system_message, prompt_profile, orchestrator_policy, num_ctx, extra_json, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    model["id"],
                    model.get("provider", ""),
                    model.get("name", ""),
                    model.get("api_key", ""),
                    model.get("api_base", ""),
                    model.get("connection_id", ""),
                    int(bool(model.get("supports_thinking", False))),
                    int(bool(model.get("requires_single_system_message", False))),
                    model.get("prompt_profile", "full"),
                    model.get("orchestrator_policy", "direct"),
                    model.get("num_ctx"),
                    _model_extra_json(model),
                    index,
                ),
            )


def load_connections() -> List[Dict[str, Any]]:
    """Load provider connections from the global SQLite store."""
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM {_CONNECTIONS_TABLE} ORDER BY sort_order ASC, id ASC"
        ).fetchall()
    return [normalize_connection_entry(dict(row)) for row in rows]


def save_connections(connections: List[Dict[str, Any]]) -> None:
    """Save provider connections list to the global SQLite store."""
    with _connect() as conn:
        conn.execute(f"DELETE FROM {_CONNECTIONS_TABLE}")
        for index, raw_connection in enumerate(connections or []):
            connection = normalize_connection_entry(raw_connection)
            if not connection.get("id"):
                continue
            conn.execute(
                f"""
                INSERT INTO {_CONNECTIONS_TABLE}
                (id, label, provider, api_key, api_base, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    connection["id"],
                    connection.get("label", ""),
                    connection.get("provider", ""),
                    connection.get("api_key", ""),
                    connection.get("api_base", ""),
                    index,
                ),
            )


def get_connection(connection_id: str) -> Dict[str, Any] | None:
    """Get a specific provider connection by ID."""
    for c in load_connections():
        if c.get("id") == connection_id:
            return c
    return None


def add_or_update_connection(connection_data: Dict[str, Any]) -> None:
    """Add a new provider connection or update an existing one by ID.

    A connection's ID is stable once created: this function never renames a
    connection's ID, it only replaces the row's fields in place, so models
    referencing it by `connection_id` never need a rename cascade.
    """
    if not str(connection_data.get("id", "")).strip():
        raise ValueError("Connection data must contain an 'id' field")

    connections = load_connections()
    connection_data = normalize_connection_entry(connection_data)
    connection_id = connection_data["id"]

    updated = False
    for i, c in enumerate(connections):
        if c.get("id") == connection_id:
            connections[i] = connection_data
            updated = True
            break

    if not updated:
        connections.append(connection_data)

    save_connections(connections)


def delete_connection(connection_id: str) -> bool:
    """Delete a provider connection by ID.

    Refuses to delete a connection that still has models referencing it:
    silently cascading would leave a project's stored model id pointing at a
    row with no resolvable credentials, turning a clear "connection in use"
    error into a confusing downstream provider-auth failure later.
    """
    blocking = [m.get("id") for m in load_models() if m.get("connection_id") == connection_id]
    if blocking:
        raise ValueError(
            f"Connection '{connection_id}' is used by {len(blocking)} model(s): {', '.join(blocking)}"
        )

    connections = load_connections()
    initial_length = len(connections)
    connections = [c for c in connections if c.get("id") != connection_id]

    if len(connections) < initial_length:
        save_connections(connections)
        return True
    return False


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

    if not get_connection(_LOCAL_OLLAMA_CONNECTION_ID):
        add_or_update_connection({
            "id": _LOCAL_OLLAMA_CONNECTION_ID,
            "label": "Local Ollama",
            "provider": "ollama",
            "api_key": "",
            "api_base": _LOCAL_OLLAMA_API_BASE,
        })

    configured_models = load_models()
    configured_names = {
        model.get("name", "")
        for model in configured_models
        if model.get("connection_id") == _LOCAL_OLLAMA_CONNECTION_ID
    }
    configured_ids = {model.get("id", "") for model in configured_models}
    additions: List[Dict[str, Any]] = []

    for remote_model in remote_models:
        model_name = str(remote_model.get("name", "") if isinstance(remote_model, dict) else "").strip()
        if not model_name or model_name in configured_names:
            continue

        base_id = f"ollama/{model_name}"
        model_id = base_id if base_id not in configured_ids else f"{base_id}#{_LOCAL_OLLAMA_CONNECTION_ID}"

        additions.append(normalize_model_entry({
            "id": model_id,
            "connection_id": _LOCAL_OLLAMA_CONNECTION_ID,
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
    the same provider/model is configured against multiple connections.
    LiteLLM must always receive the original ``provider/name`` identifier.
    """
    configured_model = get_model(str(model_id or ""))
    if configured_model:
        provider = configured_model.get("provider", "")
        name = configured_model.get("name", "")
        if provider and name:
            return f"{provider}/{name}"
    return str(model_id or "")


def _ollama_runtime_variants(runtime_model: str) -> List[str]:
    """Return the catalog identifiers a runtime Ollama model id may come from.

    ``config.resolve_model_for_thinking`` rewrites ``ollama/<name>`` to
    ``ollama_chat/<name>`` when thinking is requested, so a runtime id served
    by the native chat endpoint can originate from an ``ollama/`` catalog
    entry. The rewrite is one-way, hence only that direction is considered.
    """
    if runtime_model.startswith("ollama_chat/"):
        return [runtime_model, "ollama/" + runtime_model[len("ollama_chat/"):]]
    return [runtime_model]


def get_model_by_runtime_id(model_id: str) -> Dict[str, Any] | None:
    """Get the catalog entry behind a model identifier, runtime form included.

    ``get_model`` only matches a stored entry ID. Runtime identifiers handed to
    LiteLLM are not always that string: entries configured against multiple
    connections carry a ``#<connection_id>`` suffix that
    ``resolve_runtime_model_id`` strips, and thinking-enabled Ollama models are
    rewritten from ``ollama/`` to ``ollama_chat/``. Capability lookups keyed on
    the runtime identifier (thinking, single-system-message, num_ctx, prompt
    profile) must still find the entry the user actually configured, otherwise
    every per-model capability silently reads as unset for those models.

    Resolution order: exact entry ID, then the entry whose ``provider/name``
    equals the runtime id, then the same match for the pre-rewrite ``ollama/``
    form. When several entries share a ``provider/name`` (the same model under
    different connections), the first in catalog order wins.
    """
    raw = str(model_id or "")
    if not raw:
        return None

    direct = get_model(raw)
    if direct:
        return direct

    models = load_models()
    for candidate in _ollama_runtime_variants(raw):
        for model in models:
            provider = str(model.get("provider") or "")
            name = str(model.get("name") or "")
            if provider and name and f"{provider}/{name}" == candidate:
                return model
    return None


def _has_duplicate_configuration(
    models: List[Dict[str, Any]],
    model_data: Dict[str, Any],
    previous_id: str | None,
) -> bool:
    """Return whether the connection and model name already exist together."""
    connection_id = model_data["connection_id"]
    name = model_data["name"]
    return any(
        model.get("id") != previous_id
        and model.get("connection_id") == connection_id
        and model.get("name") == name
        for model in models
    )


def add_or_update_model(model_data: Dict[str, Any]) -> None:
    """Add a new model or update an existing one by ID.

    When editing a model whose ID changed, callers can pass ``previous_id`` to
    replace the old entry instead of appending a duplicate under the new ID.
    """
    if "id" not in model_data:
        raise ValueError("Model data must contain an 'id' field")
    if not str(model_data.get("connection_id", "")).strip():
        raise ValueError("Model data must contain a 'connection_id' field")

    models = load_models()
    model_data = normalize_model_entry(model_data)
    previous_id = model_data.pop("previous_id", None)
    model_id = model_data["id"]

    if _has_duplicate_configuration(models, model_data, previous_id):
        raise ValueError(
            "A model with this name already exists for this connection"
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
