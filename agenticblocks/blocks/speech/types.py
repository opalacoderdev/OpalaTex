"""Shared types for speech synthesis blocks.

The canonical shape here is the OpenAI speech contract (``POST
/v1/audio/speech`` -> raw audio bytes), because that is what OpenAI, Azure,
Gemini and the mainstream *local* servers already speak: Kokoro-FastAPI,
openedai-speech, LocalAI and the Piper wrappers all expose that exact route.
Adapters translate their provider into these types; callers never see a
provider-specific payload.

Unlike images, a speech response is normally raw bytes rather than a JSON
envelope, so an artifact here always carries its payload inline.
"""

from __future__ import annotations

import base64
from typing import Any

from pydantic import BaseModel, Field


class SpeechSynthesisError(RuntimeError):
    """Raised when audio cannot be produced.

    ``kind`` classifies the failure so callers can render an actionable message
    without parsing provider prose:

    - ``"not_configured"``  no model/route was given
    - ``"unknown_route"``   the requested adapter is not registered
    - ``"auth"``            credentials missing or rejected
    - ``"connection"``      the endpoint could not be reached
    - ``"bad_request"``     the provider rejected the request (voice, format, …)
    - ``"unsupported"``     the endpoint exists but does not do speech synthesis
    - ``"too_long"``        the text exceeds what the caller allows
    - ``"empty"``           the call succeeded but returned no audio
    - ``"unknown"``         anything else
    """

    def __init__(self, message: str, kind: str = "unknown") -> None:
        super().__init__(message)
        self.kind = kind


class SpeechArtifact(BaseModel):
    """One synthesized utterance, as bytes-in-base64.

    ``mime`` is what the caller should serve the bytes as. Providers are
    unreliable about reporting it -- several return ``application/octet-stream``
    for an MP3 -- so it is sniffed from the payload when it cannot be trusted
    (:func:`sniff_audio_mime`). Serving audio under the wrong type is not
    cosmetic: a browser refuses to decode it.
    """

    data_b64: str = ""
    mime: str = ""
    voice: str = ""
    model: str = ""

    def has_bytes(self) -> bool:
        return bool(self.data_b64)

    def to_bytes(self) -> bytes:
        """Decode the inline payload.

        Raises ``SpeechSynthesisError`` rather than returning b"" for an empty
        artifact: a caller that serves zero bytes produces a player that looks
        like it loaded something and did not.
        """
        if not self.data_b64:
            raise SpeechSynthesisError(
                "This speech artifact carries no audio data.", kind="empty"
            )
        return base64.b64decode(self.data_b64)


class SpeechSynthesisInput(BaseModel):
    """Provider-neutral request.

    ``language`` is not part of the OpenAI contract but several local engines
    (Piper, Kokoro, Coqui) select a voice model from it, and it is what makes
    "pronounce this excerpt" work for a document that is not in the user's own
    language. It is forwarded only when set, so a provider that does not know
    it never receives it; one that receives it and refuses fails loudly rather
    than silently reading the text in the wrong accent.
    """

    text: str
    voice: str = ""
    response_format: str = ""
    speed: float | None = None
    language: str = ""
    instructions: str = ""
    extra_params: dict[str, Any] = Field(default_factory=dict)


class SpeechSynthesisOutput(BaseModel):
    audio: SpeechArtifact
    model: str = ""
    route: str = ""


def sniff_audio_mime(data: bytes) -> str:
    """Return the MIME type of *data* from its magic bytes, or "" if unknown.

    The speech route returns bytes with a content type the caller often cannot
    trust, and the type handed to an ``<audio>`` element has to match the actual
    payload or the browser will not decode it.
    """
    if not data:
        return ""
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"fLaC":
        return "audio/flac"
    if data[:4] == b"\x00\x00\x00\x20" and data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    return ""


# The formats the OpenAI speech contract defines, mapped to what they should be
# served as. A provider may return any of them depending on `response_format`.
_FORMAT_MIMES = {
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/wav",
}


def mime_for_audio_format(fmt: str) -> str:
    """Return the MIME type conventionally used for *fmt*, or ""."""
    return _FORMAT_MIMES.get(str(fmt or "").strip().lower(), "")


def extension_for_audio_mime(mime: str) -> str:
    """Return the file extension (with dot) conventionally used for *mime*."""
    return {
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/aac": ".aac",
        "audio/mp4": ".m4a",
    }.get(mime, ".mp3")
