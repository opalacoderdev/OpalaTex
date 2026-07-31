"""Opt-in debug logging for model and agent transport flow."""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any


_SECRET_KEYS = {"api_key", "authorization", "password", "secret"}
_SECRET_KEY_FRAGMENTS = {"access_token", "refresh_token", "bearer_token"}


def llm_debug_enabled() -> bool:
    """Return whether verbose LLM transport diagnostics are enabled."""
    raw = str(os.getenv("OPALATEX_LLM_DEBUG", "1")).strip().lower()
    if raw in {"0", "false", "no", "off", "quiet"}:
        return False
    return raw in {
        "1",
        "true",
        "yes",
        "on",
        "debug",
    }


def debug_preview(value: Any, *, limit: int = 500) -> str:
    """Return a single-line, truncated, redacted preview for logs."""
    text = _safe_json(value) if isinstance(value, (dict, list, tuple)) else str(value)
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    if len(text) > limit:
        return text[: limit - 15] + "... [truncated]"
    return text


def debug_llm_flow(stage: str, **details: Any) -> None:
    """Write a structured debug line to stderr when explicitly enabled."""
    if not llm_debug_enabled():
        return
    try:
        clean = {key: _redact_value(key, value) for key, value in details.items()}
        rendered = " ".join(
            f"{key}={debug_preview(value, limit=700)}" for key, value in clean.items()
        )
        stamp = time.strftime("%H:%M:%S")
        line = f"[OPALATEX_LLM_DEBUG {stamp}] {stage} {rendered}"
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception as exc:
        try:
            sys.stderr.write(f"[OPALATEX_LLM_DEBUG] failed to render log: {exc}\n")
            sys.stderr.flush()
        except Exception:
            pass


def summarize_messages(messages: list[dict[str, Any]], *, tail: int = 4) -> list[dict[str, Any]]:
    """Summarize chat messages without dumping the full conversation."""
    summary: list[dict[str, Any]] = []
    for msg in (messages or [])[-tail:]:
        if not isinstance(msg, dict):
            summary.append({"type": type(msg).__name__, "preview": debug_preview(msg, limit=200)})
            continue
        tool_calls = msg.get("tool_calls") or []
        summary.append(
            {
                "role": msg.get("role"),
                "name": msg.get("name"),
                "content_len": len(str(msg.get("content") or "")),
                "content_preview": debug_preview(msg.get("content") or "", limit=240),
                "tool_calls": _summarize_tool_calls(tool_calls),
                "tool_call_id": msg.get("tool_call_id"),
            }
        )
    return summary


def _summarize_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    summarized: list[dict[str, Any]] = []
    if not isinstance(tool_calls, list):
        return summarized
    for call in tool_calls:
        fn = getattr(call, "function", None)
        if isinstance(call, dict):
            fn = call.get("function") or {}
            name = fn.get("name") if isinstance(fn, dict) else None
            arguments = fn.get("arguments") if isinstance(fn, dict) else ""
            call_id = call.get("id")
        else:
            name = getattr(fn, "name", None)
            arguments = getattr(fn, "arguments", "")
            call_id = getattr(call, "id", None)
        summarized.append(
            {
                "id": call_id,
                "name": name,
                "arguments_len": len(str(arguments or "")),
                "arguments_preview": debug_preview(arguments or "", limit=240),
            }
        )
    return summarized


def _redact_value(key: str, value: Any) -> Any:
    low_key = str(key).lower()
    if low_key in _SECRET_KEYS or any(secret in low_key for secret in _SECRET_KEY_FRAGMENTS):
        return "[redacted]"
    if isinstance(value, dict):
        return {k: _redact_value(str(k), v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(key, item) for item in value]
    return value


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)
