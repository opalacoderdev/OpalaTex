"""Public client for the private OpalaWebPage cloud service.

This module contains only the API contract needed by the desktop application.
Credits, billing, provider credentials, and authorization decisions remain
authoritative on the remote service.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


DEFAULT_CLOUD_BASE_URL = "https://opalacoder.com"
CLOUD_BASE_URL = os.environ.get("OPALATEX_CLOUD_BASE_URL", DEFAULT_CLOUD_BASE_URL).rstrip("/")
CHAT_PROXY_URL = f"{CLOUD_BASE_URL}/api/chat-proxy"

DEFAULT_CLOUD_MODEL_ALIAS = "OpalaTexCloud"
CLOUD_FLASH_MODEL_ALIAS = "OpalaTexCloudGemini35Flash"

CLOUD_MODEL_ALIASES = {
    DEFAULT_CLOUD_MODEL_ALIAS: {
        "litellm_model": "openai/gemini-3.1-flash-lite",
        "provider_model": "gemini-3.1-flash-lite",
        "credit_multiplier": 1,
    },
    CLOUD_FLASH_MODEL_ALIAS: {
        "litellm_model": "openai/gemini-3.5-flash",
        "provider_model": "gemini-3.5-flash",
        "credit_multiplier": 4,
    },
}

_CLOUD_LITELLM_TO_ALIAS = {
    meta["litellm_model"]: alias for alias, meta in CLOUD_MODEL_ALIASES.items()
}


def is_cloud_model_alias(model: str | None) -> bool:
    """Return True when *model* is one of the client-exposed Opala Cloud aliases."""
    return str(model or "") in CLOUD_MODEL_ALIASES


def normalize_cloud_model_alias(model: str | None, default_alias: str | None = None) -> str:
    """Return an allowed Cloud alias, defaulting safely to an allowed fallback."""
    value = str(model or "")
    if value in CLOUD_MODEL_ALIASES:
        return value
    if value in _CLOUD_LITELLM_TO_ALIAS:
        return _CLOUD_LITELLM_TO_ALIAS[value]
    fallback = str(default_alias or "")
    if fallback in CLOUD_MODEL_ALIASES:
        return fallback
    return DEFAULT_CLOUD_MODEL_ALIAS


def resolve_cloud_model_alias(model: str | None) -> str:
    """Map Opala Cloud aliases to the OpenAI-compatible model id sent to the proxy."""
    value = str(model or "")
    if value in CLOUD_MODEL_ALIASES:
        return CLOUD_MODEL_ALIASES[value]["litellm_model"]
    return value


class CloudAPIError(RuntimeError):
    """Raised when OpalaWebPage rejects a request or cannot be reached."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _request_json(
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    license_key: str = "",
    timeout: float = 10,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if license_key:
        headers["Authorization"] = f"Bearer {license_key}"

    request = urllib.request.Request(
        f"{CLOUD_BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            message = body.get("error") or body.get("message") or str(exc)
        except Exception:
            message = str(exc)
        raise CloudAPIError(message, exc.code) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CloudAPIError(f"Cloud service unavailable: {exc}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CloudAPIError("Cloud service returned an invalid response.") from exc

    if not isinstance(result, dict):
        raise CloudAPIError("Cloud service returned an invalid response.")
    return result


def get_balance(license_key: str, *, timeout: float = 3) -> dict[str, Any]:
    """Return the server-authoritative credit balance for a license."""
    if not license_key.strip():
        raise CloudAPIError("A license key is required.")
    return _request_json("/api/get-balance", license_key=license_key.strip(), timeout=timeout)


def validate_license(license_key: str) -> dict[str, Any]:
    """Validate a license through an authenticated server request."""
    return get_balance(license_key)
