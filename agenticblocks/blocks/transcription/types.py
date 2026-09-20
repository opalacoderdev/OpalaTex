"""Shared types for transcription blocks.

The canonical shape is the OpenAI transcription contract (audio in, text out,
with the detected language alongside it), because that is what hosted providers
and the local servers built around Whisper all speak. Adapters translate their
engine into these types; callers never see an engine-specific payload.

Audio crosses this boundary as **bytes with a container**, not as a decoded
waveform: every engine worth using reads a container itself, and handing one a
raw float array means the caller has to know the sample rate the engine wants.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TranscriptionError(RuntimeError):
    """Raised when audio cannot be turned into text.

    ``kind`` classifies the failure so callers can render an actionable message
    without parsing engine prose:

    - ``"not_configured"``  no model is installed or selected
    - ``"unknown_route"``   the requested adapter is not registered
    - ``"auth"``            credentials missing or rejected
    - ``"connection"``      a remote engine could not be reached
    - ``"bad_request"``     the audio was empty, malformed or unreadable
    - ``"too_long"``        the clip exceeds what the caller allows
    - ``"empty"``           the engine ran but heard nothing
    - ``"unknown"``         anything else
    """

    def __init__(self, message: str, kind: str = "unknown") -> None:
        super().__init__(message)
        self.kind = kind


class TranscriptionInput(BaseModel):
    """Provider-neutral request.

    ``language`` is a hint, not a filter: leaving it empty lets the engine
    detect, which is right for a user who dictates in more than one language,
    while setting it removes the most common source of a wrong transcript --
    a short clip detected as the wrong language.
    """

    audio: bytes
    filename: str = "audio.wav"
    language: str = ""
    prompt: str = ""
    extra_params: dict[str, Any] = Field(default_factory=dict)


class TranscriptionOutput(BaseModel):
    text: str
    language: str = ""
    language_probability: float = 0.0
    duration: float = 0.0
    model: str = ""
    route: str = ""
