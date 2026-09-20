"""Provider connections and catalog models as slash commands.

Registering a model has two halves, and both were reachable only through the
desktop Settings dialog:

* a **provider connection** — a label, a LiteLLM provider, an API base and a
  key. Credentials live here, so rotating a key updates every model that uses
  the connection.
* a **catalog model** — a name under a connection, plus the capabilities and
  inference parameters that describe *that* model (`supports_thinking`,
  `num_ctx`, `temperature`, …).

``/set-main-model`` only points a project at an id. Without a catalog entry
behind that id, `config.get_agent_llm_kwargs` finds no `api_base`, no key and no
capabilities, so the run reaches the provider unauthenticated and every
per-model setting reads as unset. Registering is what makes an id usable.

These commands go in the shared registry, so they work in the REPL, in a
one-shot ``opalatex -p``, over the stdin protocol and in the desktop chat's
command box: they change a global store, not terminal state.

Arguments are ``key=value`` pairs rather than positionals. Values may be quoted.
An unrecognised key is refused with the list of known fields instead of being
forwarded to the provider as an inference parameter -- a typo would otherwise
become a silent, invisible setting. Deliberate pass-through parameters are
written ``extra.<name>=<value>``.
"""

from __future__ import annotations

import shlex
from typing import Any

from . import terminal as T
from .cli_commands import REPLState, _parse_model_param_value, _registry
from .i18n import _
from rich.markup import escape as _escape

#: Catalog fields a model command accepts, with the way each value is read.
_MODEL_FIELDS: dict[str, str] = {
    "name": "str",
    "id": "str",
    "connection_id": "str",
    "supports_thinking": "bool",
    "requires_single_system_message": "bool",
    "prompt_profile": "prompt_profile",
    "orchestrator_policy": "orchestrator_policy",
    "num_ctx": "int",
    "temperature": "float",
    "max_tokens": "int",
    "seed": "int",
    "top_p": "float",
    "top_k": "int",
    "min_p": "float",
    "frequency_penalty": "float",
    "presence_penalty": "float",
    "repetition_penalty": "float",
    "reasoning_effort": "str",
    "supports_image_generation": "bool",
    "image_route": "str",
    "supports_speech_synthesis": "bool",
    "speech_route": "str",
}

#: Spellings accepted for a field, so the command reads the way it is spoken.
_MODEL_ALIASES = {
    "connection": "connection_id",
    "thinking": "supports_thinking",
    "profile": "prompt_profile",
    "policy": "orchestrator_policy",
    "context": "num_ctx",
}

_CONNECTION_FIELDS: dict[str, str] = {
    "id": "str",
    "label": "str",
    "provider": "str",
    "api_key": "str",
    "api_base": "str",
}

_CONNECTION_ALIASES = {"key": "api_key", "base": "api_base", "url": "api_base"}

_TRUE = {"true", "yes", "on", "1"}
_FALSE = {"false", "no", "off", "0"}


class ArgumentError(ValueError):
    """A key=value argument the command refuses to guess at."""


def parse_pairs(
    args: list[str],
    fields: dict[str, str],
    aliases: dict[str, str],
    *,
    allow_extra: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read ``key=value`` arguments into (known fields, pass-through params)."""
    text = " ".join(args).strip()
    if not text:
        return {}, {}
    try:
        tokens = shlex.split(text)
    except ValueError as exc:
        raise ArgumentError(f"Could not read the arguments: {exc}") from exc

    values: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for token in tokens:
        if "=" not in token:
            raise ArgumentError(
                f"'{token}' is not a key=value pair. "
                f"Known keys: {', '.join(sorted(fields))}."
            )
        key, raw = token.split("=", 1)
        key = key.strip()
        raw = raw.strip()

        if key.startswith("extra."):
            if not allow_extra:
                raise ArgumentError("Pass-through parameters are only accepted for models.")
            name = key[len("extra."):].strip()
            if not name:
                raise ArgumentError("'extra.' needs a parameter name after the dot.")
            extra[name] = _parse_model_param_value(raw)
            continue

        key = aliases.get(key, key)
        kind = fields.get(key)
        if kind is None:
            raise ArgumentError(
                f"Unknown field '{key}'. Known fields: {', '.join(sorted(fields))}"
                + (". Use extra.<name>=<value> for a provider parameter." if allow_extra else ".")
            )
        values[key] = _coerce(key, raw, kind)
    return values, extra


def _coerce(key: str, raw: str, kind: str) -> Any:
    if kind == "str":
        return raw
    low = raw.lower()
    if kind == "bool":
        if low in _TRUE:
            return True
        if low in _FALSE:
            return False
        raise ArgumentError(f"'{key}' takes true or false, not '{raw}'.")
    if kind == "int":
        try:
            return int(raw)
        except ValueError:
            raise ArgumentError(f"'{key}' takes a whole number, not '{raw}'.") from None
    if kind == "float":
        try:
            return float(raw.replace(",", "."))
        except ValueError:
            raise ArgumentError(f"'{key}' takes a number, not '{raw}'.") from None
    if kind == "prompt_profile":
        if low not in ("full", "light"):
            raise ArgumentError(f"'{key}' takes full or light, not '{raw}'.")
        return low
    if kind == "orchestrator_policy":
        if low not in ("direct", "delegate"):
            raise ArgumentError(f"'{key}' takes direct or delegate, not '{raw}'.")
        return low
    return raw


def _mask(secret: str) -> str:
    """Show that a key exists without printing it into a terminal or a log."""
    if not secret:
        return "—"
    return f"{secret[:4]}…{secret[-2:]}" if len(secret) > 8 else "set"


# ─── /providers ───────────────────────────────────────────────────────────────


@_registry.register(
    "/providers", "/provider",
    usage="[list | add key=value... | remove <id>]",
    description="List, register, or remove a provider connection (credentials)",
    details='A connection holds the credentials that every model under it uses,\nso rotating a key once updates all of them.\n\nExamples:\n  /providers                               list connections and how many models each carries\n  /providers add label="Ollama Gil" provider=ollama api_base=http://192.168.0.10:11434/v1\n  /providers add label="OpenAI" provider=openai api_key=sk-...\n  /providers add id=openai label="OpenAI" provider=openai api_key=       clear the key\n  /providers remove ollama-gil\n\nFields: label, provider, api_base (=base, =url), api_key (=key), id.\n\nThe id is derived from the label unless you pass id=. Adding with an existing\nid edits that connection, and leaving api_key out keeps the stored one.\nA connection still used by a model is not removed.',
)
async def cmd_providers(state: REPLState, args: list[str]) -> str | None:
    from .models_store import (
        add_or_update_connection, delete_connection, get_connection,
        load_connections, load_models, suggest_connection_id,
    )

    parts = " ".join(args).split()
    action = parts[0].lower() if parts else "list"
    rest = parts[1:]

    if action == "list":
        connections = load_connections()
        if not connections:
            T.info(_("cli_no_providers"))
            return "continue"
        counts: dict[str, int] = {}
        for model in load_models():
            counts[model.get("connection_id", "")] = counts.get(model.get("connection_id", ""), 0) + 1
        T.console.print(f"\n[dim]{_('cli_providers_header')}[/dim]")
        for connection in connections:
            used = counts.get(connection["id"], 0)
            T.console.print(
                f"  [cyan]{_escape(connection['id'])}[/cyan]  "
                f"[bold]{_escape(connection.get('label') or '')}[/bold]  "
                f"[dim]provider={_escape(connection.get('provider') or '—')}  "
                f"base={_escape(connection.get('api_base') or '—')}  "
                f"key={_mask(connection.get('api_key') or '')}  "
                f"models={used}[/dim]"
            )
        T.console.print()
        return "continue"

    if action == "add":
        try:
            values, _unused = parse_pairs(rest, _CONNECTION_FIELDS, _CONNECTION_ALIASES)
        except ArgumentError as exc:
            T.error(str(exc))
            return "continue"
        label = str(values.get("label") or "").strip()
        provider = str(values.get("provider") or "").strip()
        if not label or not provider:
            T.error(_("cli_usage_providers_add"))
            return "continue"
        connection_id = str(values.get("id") or "").strip() or suggest_connection_id(label)
        existing = get_connection(connection_id)
        payload = {
            "id": connection_id,
            "label": label,
            "provider": provider,
            "api_key": values.get("api_key", existing.get("api_key", "") if existing else ""),
            "api_base": values.get("api_base", existing.get("api_base", "") if existing else ""),
        }
        try:
            add_or_update_connection(payload)
        except Exception as exc:
            T.error(str(exc))
            return "continue"
        T.success(_(
            "cli_provider_updated" if existing else "cli_provider_added",
            id=connection_id,
        ))
        return "continue"

    if action == "remove":
        if not rest:
            T.error(_("cli_usage_providers_remove"))
            return "continue"
        connection_id = rest[0]
        try:
            removed = delete_connection(connection_id)
        except ValueError as exc:
            # Refused because models still reference it; say which.
            T.error(str(exc))
            return "continue"
        if removed:
            T.success(_("cli_provider_removed", id=connection_id))
        else:
            T.error(_("cli_provider_not_found", id=connection_id))
        return "continue"

    T.error(_("cli_usage_providers"))
    return "continue"


# ─── /models (catalog half) ───────────────────────────────────────────────────


def _print_model(model: dict) -> None:
    T.console.print(f"\n[bold]{_escape(model.get('id') or '')}[/bold]")
    rows = [
        ("name", model.get("name")),
        ("provider", model.get("provider")),
        ("connection", f"{model.get('connection_id') or '—'} ({model.get('connection_label') or '—'})"),
        ("api_base", model.get("api_base") or "—"),
        ("api_key", _mask(model.get("api_key") or "")),
        ("num_ctx", model.get("num_ctx")),
        ("supports_thinking", model.get("supports_thinking")),
        ("requires_single_system_message", model.get("requires_single_system_message")),
        ("prompt_profile", model.get("prompt_profile")),
        ("orchestrator_policy", model.get("orchestrator_policy")),
    ]
    for key in ("temperature", "max_tokens", "seed", "top_p", "top_k", "min_p",
                "frequency_penalty", "presence_penalty", "repetition_penalty",
                "reasoning_effort"):
        if model.get(key) is not None:
            rows.append((key, model.get(key)))
    for key, value in rows:
        T.console.print(f"  [cyan]{key:<32}[/cyan] {_escape(str(value))}")
    extra = model.get("extra_model_params") or {}
    for key, value in extra.items():
        T.console.print(f"  [cyan]extra.{key:<26}[/cyan] {_escape(str(value))}")
    T.console.print()


#: Fields a model row shows but does not own: they are joined from its provider
#: connection (`models_store._row_to_model`). Writing them back would leave a
#: copy of the connection's key in the model row, stale the moment it is
#: rotated. The desktop form never sends them either.
_CONNECTION_OWNED = ("provider", "api_key", "api_base", "connection_label")


async def catalog_models(state: REPLState, action: str, rest: list[str]) -> str:
    """The catalog half of `/models`: list, show, add, set, remove."""
    from .models_store import (
        add_or_update_model, delete_model, get_connection, get_model,
        load_models, suggest_model_id,
    )

    if action == "list":
        models = load_models()
        if not models:
            T.info(_("cli_no_catalog_models"))
            return "continue"
        T.console.print(f"\n[dim]{_('cli_catalog_header')}[/dim]")
        for model in models:
            T.console.print(
                f"  [cyan]{_escape(model.get('id') or '')}[/cyan]  "
                f"[dim]connection={_escape(model.get('connection_id') or '—')}  "
                f"ctx={model.get('num_ctx') or '—'}  "
                f"thinking={'yes' if model.get('supports_thinking') else 'no'}  "
                f"profile={model.get('prompt_profile')}/{model.get('orchestrator_policy')}[/dim]"
            )
        T.console.print()
        return "continue"

    if action == "show":
        if not rest:
            T.error(_("cli_usage_models_show"))
            return "continue"
        model = get_model(" ".join(rest).strip())
        if model is None:
            T.error(_("cli_model_not_found", id=" ".join(rest).strip()))
            return "continue"
        _print_model(model)
        return "continue"

    if action == "remove":
        if not rest:
            T.error(_("cli_usage_models_remove"))
            return "continue"
        model_id = " ".join(rest).strip()
        if delete_model(model_id):
            T.success(_("cli_model_removed", id=model_id))
        else:
            T.error(_("cli_model_not_found", id=model_id))
        return "continue"

    if action == "add":
        try:
            values, extra = parse_pairs(rest, _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True)
        except ArgumentError as exc:
            T.error(str(exc))
            return "continue"
        name = str(values.get("name") or "").strip()
        connection_id = str(values.get("connection_id") or "").strip()
        if not name or not connection_id:
            T.error(_("cli_usage_models_add"))
            return "continue"
        connection = get_connection(connection_id)
        if connection is None:
            T.error(_("cli_provider_not_found", id=connection_id))
            return "continue"
        payload = dict(values)
        payload["name"] = name
        payload["connection_id"] = connection_id
        payload["id"] = str(values.get("id") or "").strip() or suggest_model_id(
            connection.get("provider", ""), name, connection_id
        )
        if extra:
            payload["extra_model_params"] = extra
        try:
            add_or_update_model(payload)
        except Exception as exc:
            T.error(str(exc))
            return "continue"
        T.success(_("cli_model_added", id=payload["id"]))
        T.console.print(f"[dim]{_('cli_model_added_hint', id=payload['id'])}[/dim]")
        return "continue"

    if action == "set":
        if not rest:
            T.error(_("cli_usage_models_set"))
            return "continue"
        model_id, pairs = rest[0], rest[1:]
        model = get_model(model_id)
        if model is None:
            T.error(_("cli_model_not_found", id=model_id))
            return "continue"
        if not pairs:
            T.error(_("cli_usage_models_set"))
            return "continue"
        try:
            values, extra = parse_pairs(pairs, _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True)
        except ArgumentError as exc:
            T.error(str(exc))
            return "continue"
        payload = {k: v for k, v in model.items() if k not in _CONNECTION_OWNED}
        payload.update(values)
        # `previous_id` is how the store replaces an entry whose id changed
        # instead of appending a second one under the new id.
        payload["previous_id"] = model_id
        if extra:
            merged = dict(model.get("extra_model_params") or {})
            merged.update(extra)
            payload["extra_model_params"] = merged
        if values.get("connection_id") and get_connection(values["connection_id"]) is None:
            T.error(_("cli_provider_not_found", id=values["connection_id"]))
            return "continue"
        try:
            add_or_update_model(payload)
        except Exception as exc:
            T.error(str(exc))
            return "continue"
        T.success(_("cli_model_updated", id=payload.get("id") or model_id))
        return "continue"

    T.error(_("cli_usage_models_catalog"))
    return "continue"
