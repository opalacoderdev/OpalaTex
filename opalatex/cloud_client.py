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
