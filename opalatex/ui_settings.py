"""Persistent UI settings for OpalaTex.

Stored at ~/.opalatex/ui_settings.json so they survive webview sessions,
which do not persist localStorage between app restarts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import get_opalatex_home
from .cloud_client import DEFAULT_CLOUD_MODEL_ALIAS, normalize_cloud_model_alias

_SETTINGS_PATH = Path(get_opalatex_home()) / "ui_settings.json"

_DEFAULTS: dict[str, Any] = {
    "lang": "",  # "" means detect from OS; "en" or "pt-BR" for explicit choice
    "ai_provider": "local",
    "cloud_model": DEFAULT_CLOUD_MODEL_ALIAS,
}


def load_ui_settings() -> dict[str, Any]:
    try:
        if _SETTINGS_PATH.exists():
            raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
            return {**_DEFAULTS, **raw}
    except Exception:
        pass
    return dict(_DEFAULTS)


def save_ui_settings(settings: dict[str, Any]) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_ui_settings()
    if "cloud_model" in settings:
        settings = dict(settings)
        settings["cloud_model"] = normalize_cloud_model_alias(settings.get("cloud_model"))
    current.update(settings)
    _SETTINGS_PATH.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
