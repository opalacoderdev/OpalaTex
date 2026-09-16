"""Chromium flags for the embedded QtWebEngine window.

QtWebEngine does not run its GPU service in a child process the way a stand-alone
Chromium does: on Windows the graphics driver is loaded into *this* process, so a
fault in it is a fault in OpalaTex — the window vanishes, the Python interpreter
never gets an exception, and the terminal stays empty (see `crash_report`). The
only defence the application has is to ask Chromium not to use the GPU at all,
which trades smooth compositing for a renderer that cannot take the process down
with it.

That is a real cost, so it is never applied silently: `GPU_OFF` is chosen by the
user, in Settings or through ``OPALATEX_DISABLE_GPU``, and the choice is recorded
in the crash log next to the run it belongs to, which is what makes "did turning
it off help?" an answerable question.

The Linux default is the one exception, and it predates this module: QtWebEngine's
GPU process can abort at startup when Mesa's Zink/EGL layer cannot acquire a DRM
render node, which is a blank window rather than a slow one. Setting the flags
variable by hand still wins there, as it always did.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Mapping, MutableMapping

CHROMIUM_FLAGS_VAR = "QTWEBENGINE_CHROMIUM_FLAGS"
DISABLE_GPU_VAR = "OPALATEX_DISABLE_GPU"
DISABLE_GPU_FLAG = "--disable-gpu"

GPU_AUTO = "auto"
GPU_OFF = "off"
GPU_MODES = (GPU_AUTO, GPU_OFF)

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def normalize_gpu_mode(value: Any) -> str:
    """Coerce a stored or user-supplied value into a valid mode.

    Anything unrecognised becomes `GPU_AUTO`: a corrupted settings file must not
    leave the application permanently in software rendering with no explanation.
    """
    text = str(value or "").strip().lower()
    if text in GPU_MODES:
        return text
    if text in _TRUE:  # "disable gpu: true", written by an older or hand-edited file
        return GPU_OFF
    return GPU_AUTO


def resolve_gpu_mode(
    env: Mapping[str, str] | None = None,
    settings: Mapping[str, Any] | None = None,
) -> tuple[str, str]:
    """Return ``(mode, source)``.

    The environment variable wins over the saved setting in both directions, so
    a user who cannot open Settings because the window keeps dying can still
    start the application, and one who wants the GPU back for a single run can
    ask for it without changing what is saved.
    """
    env = os.environ if env is None else env
    raw = str(env.get(DISABLE_GPU_VAR, "")).strip().lower()
    if raw in _TRUE:
        return GPU_OFF, "env"
    if raw in _FALSE:
        return GPU_AUTO, "env"

    if settings is not None and settings.get("webengine_gpu") is not None:
        return normalize_gpu_mode(settings.get("webengine_gpu")), "settings"
    return GPU_AUTO, "default"


def _append_flag(flags: str, flag: str) -> str:
    if flag in flags.split():
        return flags
    return f"{flags} {flag}".strip()


def apply_webengine_environment(
    env: MutableMapping[str, str] | None = None,
    platform: str | None = None,
    settings: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Set `CHROMIUM_FLAGS_VAR` for this process and report what was decided.

    User-supplied flags are never dropped — the flag this adds is appended to
    whatever is already there.
    """
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform

    mode, source = resolve_gpu_mode(env, settings)
    before = env.get(CHROMIUM_FLAGS_VAR)
    flags = before or ""
    reason = ""

    if mode == GPU_OFF:
        flags = _append_flag(flags, DISABLE_GPU_FLAG)
        reason = f"GPU acceleration turned off ({source})"
    elif platform.startswith("linux") and before is None:
        # Historic default, kept verbatim in effect: QtWebEngine's GPU process
        # can segfault at startup when Mesa's Zink/EGL layer fails to acquire a
        # DRM render node (missing or inaccessible /dev/dri/render*). Users who
        # know GPU acceleration works can set the variable themselves.
        flags = _append_flag(flags, DISABLE_GPU_FLAG)
        reason = "Linux default: avoids the Mesa/Zink render-node path"

    if flags:
        env[CHROMIUM_FLAGS_VAR] = flags

    return {
        "gpu_mode": mode,
        "source": source,
        "reason": reason,
        "chromium_flags": env.get(CHROMIUM_FLAGS_VAR, ""),
        "changed": env.get(CHROMIUM_FLAGS_VAR, "") != (before or ""),
    }
