"""Speech synthesis adapters and their registry.

An adapter turns a provider-neutral :class:`SpeechSynthesisInput` into calls
against one transport and returns a :class:`SpeechArtifact`. Two ship with the
framework:

``local_onnx``
    A Piper-format voice run in this process from a downloaded ``.onnx`` file
    (see :mod:`agenticblocks.blocks.speech.local_onnx`). No network, no
    endpoint, no account -- which is what makes speech reachable for an
    offline-first host.

``audio_speech``
    The OpenAI speech contract (``POST /v1/audio/speech``), dispatched through
    LiteLLM. One adapter covers OpenAI, Azure and Gemini, plus *any*
    OpenAI-compatible server reachable through ``api_base`` -- Kokoro-FastAPI,
    openedai-speech, LocalAI, or a Piper wrapper on localhost. Adding such a
    server is a catalog entry, not code, which is what lets speech stay local
    and offline on the same code path that reaches a hosted provider.

Register more with :func:`register_speech_adapter` -- an engine LiteLLM does
not cover (a native WebSocket stream, a server with its own schema) plugs in
without touching :class:`SpeechSynthesisBlock`.
"""

from __future__ import annotations

import base64
from typing import Any, Protocol

from agenticblocks.blocks.speech.types import (
    SpeechArtifact,
    SpeechSynthesisError,
    SpeechSynthesisInput,
    mime_for_audio_format,
    sniff_audio_mime,
)

# Transport kwargs an adapter may forward to the provider. Chat parameters
# (temperature, num_ctx, think, stream, tools, …) are meaningless to a speech
# endpoint and are rejected by several of them, so callers pass credentials and
# nothing else.
TRANSPORT_KWARGS = ("api_key", "api_base", "api_version", "timeout", "extra_headers")

# The voice every OpenAI-compatible server is expected to accept. A speech
# request without a voice is a 400 on most of them, so the block needs *a*
# default -- but it is only ever used when neither the request nor the caller's
# configuration names one.
DEFAULT_VOICE = "alloy"

# The default wire format. MP3 because it is the one format every target
# decodes, in the browser and out of it.
DEFAULT_RESPONSE_FORMAT = "mp3"


class SpeechAdapter(Protocol):
    """Callable that produces audio for one transport."""

    async def __call__(
        self,
        model: str,
        request: SpeechSynthesisInput,
        model_kwargs: dict[str, Any],
    ) -> SpeechArtifact:
        ...


_ADAPTERS: dict[str, SpeechAdapter] = {}


def register_speech_adapter(route: str, adapter: SpeechAdapter) -> None:
    """Register *adapter* under *route*, replacing any previous registration."""
    if not route:
        raise ValueError("route must be a non-empty string")
    _ADAPTERS[route] = adapter


def get_speech_adapter(route: str) -> SpeechAdapter:
    try:
        return _ADAPTERS[route]
    except KeyError:
        raise SpeechSynthesisError(
            f"Unknown speech synthesis route '{route}'. Available routes: "
            f"{', '.join(sorted(_ADAPTERS)) or '(none registered)'}.",
            kind="unknown_route",
        ) from None


def available_speech_routes() -> list[str]:
    return sorted(_ADAPTERS)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _transport_kwargs(model_kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v
        for k, v in (model_kwargs or {}).items()
        if k in TRANSPORT_KWARGS and v not in (None, "")
    }


def read_audio_bytes(response: Any) -> bytes:
    """Pull the audio payload out of whatever the transport returned.

    LiteLLM answers a speech call with ``HttpxBinaryResponseContent``, which
    exposes ``.content``; some providers and every test double return plain
    bytes. Both are accepted, and anything else is reported rather than coerced
    into empty audio.
    """
    if isinstance(response, (bytes, bytearray)):
        return bytes(response)

    content = getattr(response, "content", None)
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)

    read = getattr(response, "read", None)
    if callable(read):
        data = read()
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)

    raise SpeechSynthesisError(
        f"The speech endpoint returned {type(response).__name__}, which carries no audio bytes.",
        kind="empty",
    )


def _raise_from_litellm(exc: Exception, model: str) -> None:
    """Re-raise a LiteLLM exception as a classified SpeechSynthesisError."""
    try:
        import litellm
    except ImportError:  # pragma: no cover - litellm is a hard dependency in practice
        raise SpeechSynthesisError(str(exc), kind="unknown") from exc

    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, litellm.exceptions.AuthenticationError):
        raise SpeechSynthesisError(
            f"Authentication failed for speech model '{model}'. {detail}", kind="auth"
        ) from exc
    if isinstance(exc, litellm.exceptions.APIConnectionError):
        raise SpeechSynthesisError(
            f"Could not reach the speech endpoint for '{model}'. {detail}",
            kind="connection",
        ) from exc
    if isinstance(exc, litellm.exceptions.NotFoundError):
        # A 404 on /v1/audio/speech means the server has no such route -- the
        # shape a plain Ollama returns, since it serves no speech endpoint.
        raise SpeechSynthesisError(
            f"The endpoint serving '{model}' has no speech synthesis route. {detail}",
            kind="unsupported",
        ) from exc
    if isinstance(exc, litellm.exceptions.BadRequestError):
        raise SpeechSynthesisError(
            f"The provider rejected the speech request for '{model}'. {detail}",
            kind="bad_request",
        ) from exc
    raise SpeechSynthesisError(
        f"Speech synthesis failed for '{model}'. {detail}", kind="unknown"
    ) from exc


# ─── audio_speech: the OpenAI speech contract ────────────────────────────────

async def audio_speech_adapter(
    model: str,
    request: SpeechSynthesisInput,
    model_kwargs: dict[str, Any],
) -> SpeechArtifact:
    import litellm

    kwargs: dict[str, Any] = _transport_kwargs(model_kwargs)
    response_format = (request.response_format or DEFAULT_RESPONSE_FORMAT).strip().lower()
    kwargs["response_format"] = response_format
    if request.speed is not None:
        kwargs["speed"] = float(request.speed)
    if request.instructions:
        kwargs["instructions"] = request.instructions
    # Forwarded only when set: a server that does not know `language` must be
    # allowed to reject it rather than be handed a field it will ignore.
    if request.language:
        kwargs["language"] = request.language
    kwargs.update(request.extra_params or {})

    try:
        response = await litellm.aspeech(
            model=model,
            input=request.text,
            voice=request.voice or DEFAULT_VOICE,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 - classified and re-raised below
        _raise_from_litellm(exc, model)
        raise  # unreachable, keeps type checkers happy

    data = read_audio_bytes(response)
    if not data:
        raise SpeechSynthesisError(
            f"The speech endpoint for '{model}' returned no audio.", kind="empty"
        )

    # Sniffed first: a provider's declared content type is frequently
    # `application/octet-stream`, and the browser will not decode audio served
    # under a type that does not match the bytes.
    mime = sniff_audio_mime(data) or mime_for_audio_format(response_format)
    return SpeechArtifact(
        data_b64=base64.b64encode(data).decode("ascii"),
        mime=mime,
        voice=request.voice or DEFAULT_VOICE,
        model=model,
    )


register_speech_adapter("audio_speech", audio_speech_adapter)

# Registered on import so the route exists wherever the package is imported.
# The heavy dependencies (onnxruntime, numpy, espeak-ng) are only touched when
# the route is actually used.
from agenticblocks.blocks.speech.local_onnx import local_onnx_adapter  # noqa: E402

register_speech_adapter("local_onnx", local_onnx_adapter)
