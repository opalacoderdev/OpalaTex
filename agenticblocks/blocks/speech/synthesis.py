"""SpeechSynthesisBlock: one block, several speech APIs.

The block owns validation, adapter dispatch and result normalisation; each
transport lives in an adapter (see :mod:`agenticblocks.blocks.speech.adapters`).
Callers therefore write the same code whether the audio comes from OpenAI, from
Azure, or from a Piper/Kokoro server running on localhost -- only ``model``,
``route`` and ``model_kwargs["api_base"]`` change.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from agenticblocks.blocks.speech.adapters import get_speech_adapter
from agenticblocks.blocks.speech.types import (
    SpeechSynthesisError,
    SpeechSynthesisInput,
    SpeechSynthesisOutput,
)
from agenticblocks.core.block import Block

DEFAULT_SPEECH_ROUTE = "audio_speech"

# Above this, a single request stops being "read me this passage" and becomes a
# job: providers time out, and the caller is left holding a partial file it
# cannot tell apart from a complete one. The limit is a field so a caller with
# a streaming transport can raise it deliberately.
DEFAULT_MAX_INPUT_CHARS = 4096


class SpeechSynthesisBlock(Block[SpeechSynthesisInput, SpeechSynthesisOutput]):
    """Synthesize speech from text through a pluggable transport.

    Args:
        model: provider-qualified model id, e.g. ``"openai/tts-1"`` or
            ``"openai/kokoro"`` pointed at a local server.
        route: adapter name; ``"audio_speech"`` (default).
        voice: the voice used when a request does not name one.
        response_format: wire format requested when a request does not name one.
        max_input_chars: refuse longer text instead of truncating it.
        model_kwargs: transport credentials only (``api_key``, ``api_base``,
            ``timeout``, …). Chat sampling parameters do not belong here.
    """

    name: str = "speech_synthesis"
    description: str = "Synthesizes spoken audio from text."
    model: str = ""
    route: str = DEFAULT_SPEECH_ROUTE
    voice: str = ""
    response_format: str = ""
    speed: float | None = None
    max_input_chars: int = DEFAULT_MAX_INPUT_CHARS
    model_kwargs: dict[str, Any] = Field(default_factory=dict)

    async def run(self, input: SpeechSynthesisInput) -> SpeechSynthesisOutput:
        if not (self.model or "").strip():
            raise SpeechSynthesisError(
                "No speech synthesis model configured.", kind="not_configured"
            )

        text = str(input.text or "").strip()
        if not text:
            raise SpeechSynthesisError(
                "A speech synthesis request cannot be empty.", kind="bad_request"
            )

        # Refused, never truncated: audio that stops mid-sentence is
        # indistinguishable from audio that finished, so a clipped reading
        # presented as a complete one would be a silent substitution.
        limit = max(1, int(self.max_input_chars or DEFAULT_MAX_INPUT_CHARS))
        if len(text) > limit:
            raise SpeechSynthesisError(
                f"The text is too long to synthesize in one request "
                f"({len(text)} characters, limit {limit}).",
                kind="too_long",
            )

        route = self.route or DEFAULT_SPEECH_ROUTE
        adapter = get_speech_adapter(route)

        # The block's own settings are the defaults a request may override, so a
        # caller that names a voice per request and one that configures it once
        # both work.
        request = input.model_copy(update={
            "text": text,
            "voice": input.voice or self.voice,
            "response_format": input.response_format or self.response_format,
            "speed": input.speed if input.speed is not None else self.speed,
        })

        artifact = await adapter(self.model, request, dict(self.model_kwargs or {}))

        if not artifact or not artifact.has_bytes():
            raise SpeechSynthesisError(
                f"Model '{self.model}' returned no audio for this text.", kind="empty"
            )

        return SpeechSynthesisOutput(audio=artifact, model=self.model, route=route)
