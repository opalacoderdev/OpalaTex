"""Persistent UI settings for OpalaTex.

Stored at ~/.opalatex/ui_settings.json so they survive webview sessions,
which do not persist localStorage between app restarts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import get_opalatex_home
from .extensions import get_extension_manager

_SETTINGS_PATH = Path(get_opalatex_home()) / "ui_settings.json"

_DEFAULTS: dict[str, Any] = {
    "lang": "",  # "" means detect from OS; "en" or "pt-BR" for explicit choice
    "ai_provider": "local",
    "cloud_model": "OpalaTexCloud",
    "draft_synctex_enabled": False,
    "show_hidden_workspace_files": False,
    "prompt_evolution_iterations": 1,
    "prompt_evolution_max_tokens": 4096,
}


def load_ui_settings() -> dict[str, Any]:
    res = dict(_DEFAULTS)
    try:
        if _SETTINGS_PATH.exists():
            raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
            res.update(raw)
    except Exception:
        pass

    ext_mgr = get_extension_manager()
    if not ext_mgr.has_cloud:
        res["ai_provider"] = "local"
    return res


def save_ui_settings(settings: dict[str, Any]) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_ui_settings()
    settings = dict(settings)
    ext_mgr = get_extension_manager()
    if not ext_mgr.has_cloud:
        settings["ai_provider"] = "local"
    if "cloud_model" in settings:
        ext = ext_mgr.cloud
        settings["cloud_model"] = ext.normalize_cloud_model(settings.get("cloud_model"))
    current.update(settings)
    _SETTINGS_PATH.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
