"""Persistent UI settings for OpalaTex.

Stored at ~/.opalatex/ui_settings.json so they survive webview sessions,
which do not persist localStorage between app restarts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import get_opalatex_home

_SETTINGS_PATH = Path(get_opalatex_home()) / "ui_settings.json"

_DEFAULTS: dict[str, Any] = {
    "lang": "",  # "" means detect from OS; "en" or "pt-BR" for explicit choice
    "draft_synctex_enabled": False,
    "show_hidden_workspace_files": False,
    "prompt_evolution_iterations": 1,
    "prompt_evolution_max_tokens": 4096,
    # Target language for the PDF viewer "Translate" action. "" means follow the UI language.
    "translate_target_lang": "",
}


def load_ui_settings() -> dict[str, Any]:
    res = dict(_DEFAULTS)
    try:
        if _SETTINGS_PATH.exists():
            raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
            res.update(raw)
    except Exception:
        pass
    return res


def save_ui_settings(settings: dict[str, Any]) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_ui_settings()
    current.update(settings)
    _SETTINGS_PATH.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
