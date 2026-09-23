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
    # Accessibility: global interface scale. 1.0 is the unscaled ("Medium")
    # size; the front-end applies it as a CSS zoom over the whole app. Stored
    # as the raw factor rather than a preset name so the preset ladder can be
    # changed later without migrating saved settings, and so a custom value
    # picked with the fine-tuning control is representable in the same field.
    "ui_scale": 1.0,
    # Agent reasoning, in tokens. The chat shows the most recent reasoning up
    # to this size, and resuming an interrupted turn replays the reasoning in
    # full up to this size or as a summary beyond it. Everything is stored.
    "thought_context_tokens": 32000,
    # How much of the running reasoning the *chat* shows while a turn
    # works. The chat is a preview: it keeps the last few lines in view
    # so the user can see the model is thinking, and expanding it opens
    # the Agent Thinking panel, which holds the whole thing. Rendering
    # tens of thousands of tokens inside a chat bubble is what made a
    # long turn freeze the window.
    "chat_thought_preview_tokens": 1000,
    # Graphics mode for the embedded browser window: "auto" uses the GPU,
    # "off" runs Chromium without it. QtWebEngine loads the graphics driver
    # into the OpalaTex process itself, so a driver fault kills the whole
    # application; "off" is the recovery for a machine where that happens.
    # Only takes effect at the next launch (see opalatex/webengine_env.py).
    "webengine_gpu": "auto",
}

# Bounds for "ui_scale". The upper bound keeps the app usable on a 1080p
# screen (at 2.0 the layout has ~960x540 of usable space left).
UI_SCALE_MIN = 0.8
UI_SCALE_MAX = 2.0

THOUGHT_CONTEXT_TOKENS_DEFAULT = 32000
THOUGHT_CONTEXT_TOKENS_MIN = 1000
THOUGHT_CONTEXT_TOKENS_MAX = 1_000_000


def clamp_thought_context_tokens(value: Any) -> int:
    """Coerce a stored value into a valid reasoning size, in tokens."""
    try:
        tokens = int(value)
    except (TypeError, ValueError):
        return THOUGHT_CONTEXT_TOKENS_DEFAULT
    return max(THOUGHT_CONTEXT_TOKENS_MIN, min(THOUGHT_CONTEXT_TOKENS_MAX, tokens))


CHAT_THOUGHT_PREVIEW_TOKENS_DEFAULT = 1000
CHAT_THOUGHT_PREVIEW_TOKENS_MIN = 100
CHAT_THOUGHT_PREVIEW_TOKENS_MAX = 100_000


def clamp_chat_thought_preview_tokens(value: Any) -> int:
    """Coerce a stored value into a valid chat preview size, in tokens."""
    try:
        tokens = int(value)
    except (TypeError, ValueError):
        return CHAT_THOUGHT_PREVIEW_TOKENS_DEFAULT
    return max(CHAT_THOUGHT_PREVIEW_TOKENS_MIN,
               min(CHAT_THOUGHT_PREVIEW_TOKENS_MAX, tokens))


def clamp_ui_scale(value: Any) -> float:
    """Coerce an arbitrary value into a valid ui_scale factor.

    Falls back to 1.0 for anything non-numeric so a corrupted settings file
    cannot render the interface unusable.
    """
    try:
        scale = float(value)
    except (TypeError, ValueError):
        return 1.0
    if scale != scale or scale in (float("inf"), float("-inf")):  # NaN / inf
        return 1.0
    return max(UI_SCALE_MIN, min(UI_SCALE_MAX, scale))


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
