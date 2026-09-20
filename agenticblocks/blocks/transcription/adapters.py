"""Transcription adapters and their registry.

One ships with the framework:

``local_whisper``
    OpenAI's Whisper run in this process through faster-whisper (CTranslate2).
    The model is a local directory, so transcription needs no network, no
    account and no endpoint -- the counterpart of the local voice engine, and
    what makes dictation available to an offline-first host.

Register more with :func:`register_transcription_adapter` -- a hosted provider
or a server with its own schema plugs in without touching
:class:`TranscriptionBlock`.
"""

from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Any, Protocol

from agenticblocks.blocks.transcription.types import (
    TranscriptionError,
    TranscriptionInput,
    TranscriptionOutput,
)

# Loading a Whisper model costs hundreds of milliseconds and hundreds of
# megabytes, and a dictating user speaks many short clips in a row, so a model
# is kept alive between calls. One at a time: a second model is a second copy of
# the weights, and a user dictates in one configuration.
_MAX_CACHED = 1
_cache: "dict[str, Any]" = {}
_cache_lock = threading.Lock()


class TranscriptionAdapter(Protocol):
    """Callable that turns audio into text for one engine."""

    async def __call__(
        self,
        model: str,
        request: TranscriptionInput,
        model_kwargs: dict[str, Any],
    ) -> TranscriptionOutput:
        ...


_ADAPTERS: dict[str, TranscriptionAdapter] = {}


def register_transcription_adapter(route: str, adapter: TranscriptionAdapter) -> None:
    """Register *adapter* under *route*, replacing any previous registration."""
    if not route:
        raise ValueError("route must be a non-empty string")
    _ADAPTERS[route] = adapter


def get_transcription_adapter(route: str) -> TranscriptionAdapter:
    try:
        return _ADAPTERS[route]
    except KeyError:
        raise TranscriptionError(
            f"Unknown transcription route '{route}'. Available routes: "
            f"{', '.join(sorted(_ADAPTERS)) or '(none registered)'}.",
            kind="unknown_route",
        ) from None


def available_transcription_routes() -> list[str]:
    return sorted(_ADAPTERS)


def clear_cache() -> None:
    """Drop every loaded model. Used when a model directory is replaced."""
    with _cache_lock:
        _cache.clear()


def load_whisper_model(model_path: str, compute_type: str = "int8", cpu_threads: int = 0):
    """Return a cached faster-whisper model for *model_path*."""
    path = Path(model_path)
    if not path.is_dir():
        raise TranscriptionError(
            f"The transcription model at '{path}' is not installed.",
            kind="not_configured",
        )

    key = f"{path.resolve()}::{compute_type}"
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise TranscriptionError(
            "faster-whisper is required for local transcription but is not installed.",
            kind="not_configured",
        ) from exc

    try:
        model = WhisperModel(
            str(path),
            device="cpu",
            compute_type=compute_type or "int8",
            cpu_threads=cpu_threads,
            # Never reach for the network at transcription time: a model that is
            # not on disk is a configuration problem to report, not a download
            # to start while the user waits with a recording in hand.
            local_files_only=True,
        )
    except Exception as exc:  # noqa: BLE001 - surfaced as a classified error
        raise TranscriptionError(
            f"The transcription model could not be loaded: {exc}", kind="bad_request"
        ) from exc

    with _cache_lock:
        _cache[key] = model
        while len(_cache) > _MAX_CACHED:
            _cache.pop(next(iter(_cache)))
    return model


def transcribe_sync(
    model_path: str,
    audio: bytes,
    language: str = "",
    prompt: str = "",
    compute_type: str = "int8",
    beam_size: int = 5,
) -> TranscriptionOutput:
    """Transcribe *audio* with the model at *model_path*.

    Synchronous and CPU-bound: call it from a worker thread.
    """
    if not audio:
        raise TranscriptionError("The recording is empty.", kind="bad_request")

    model = load_whisper_model(model_path, compute_type=compute_type)

    try:
        segments, info = model.transcribe(
            io.BytesIO(audio),
            language=(language or None),
            initial_prompt=(prompt or None),
            beam_size=beam_size,
        )
        # `segments` is a generator: the work happens while it is consumed, so
        # nothing is timed or reported until this join completes.
        text = "".join(segment.text for segment in segments).strip()
    except TranscriptionError:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced as a classified error
        raise TranscriptionError(
            f"The recording could not be transcribed: {exc}", kind="bad_request"
        ) from exc

    return TranscriptionOutput(
        text=text,
        language=getattr(info, "language", "") or "",
        language_probability=float(getattr(info, "language_probability", 0.0) or 0.0),
        duration=float(getattr(info, "duration", 0.0) or 0.0),
        model=Path(model_path).name,
        route="local_whisper",
    )


async def local_whisper_adapter(
    model: str,
    request: TranscriptionInput,
    model_kwargs: dict[str, Any],
) -> TranscriptionOutput:
    """Adapter for a locally installed Whisper model.

    ``model_kwargs["model_path"]`` points at the model directory; ``model`` is
    only a label, since nothing is dispatched over a network.
    """
    import asyncio

    model_path = str((model_kwargs or {}).get("model_path") or "").strip()
    if not model_path:
        raise TranscriptionError(
            "No transcription model is selected. Download one in the dictation "
            "settings.",
            kind="not_configured",
        )

    # The event loop must stay free: this is in-process, CPU-bound work.
    result = await asyncio.to_thread(
        transcribe_sync,
        model_path,
        request.audio,
        request.language,
        request.prompt,
        str((model_kwargs or {}).get("compute_type") or "int8"),
        int((model_kwargs or {}).get("beam_size") or 5),
    )
    if model:
        result.model = model
    return result


register_transcription_adapter("local_whisper", local_whisper_adapter)
