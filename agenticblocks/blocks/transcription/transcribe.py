"""TranscriptionBlock: one block, several speech-recognition engines.

The block owns validation, adapter dispatch and result normalisation; each
engine lives in an adapter (see
:mod:`agenticblocks.blocks.transcription.adapters`). Callers write the same code
whether the text comes from a Whisper model on this machine or from a hosted
provider -- only ``route`` and ``model_kwargs`` change.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from agenticblocks.blocks.transcription.adapters import get_transcription_adapter
from agenticblocks.blocks.transcription.types import (
    TranscriptionError,
    TranscriptionInput,
    TranscriptionOutput,
)
from agenticblocks.core.block import Block

DEFAULT_TRANSCRIPTION_ROUTE = "local_whisper"

# Above this a clip stops being dictation and becomes a recording job: the wait
# is long enough that the user cannot tell it apart from a hang. The limit is a
# field so a caller doing batch work can raise it deliberately.
DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024


class TranscriptionBlock(Block[TranscriptionInput, TranscriptionOutput]):
    """Turn recorded audio into text through a pluggable engine.

    Args:
        model: a label for the engine in use; for a local route it names the
            installed model rather than addressing a provider.
        route: adapter name; ``"local_whisper"`` (default).
        language: forced language hint used when a request does not name one.
        max_audio_bytes: refuse a larger clip instead of starting work that
            will not finish in a useful time.
        model_kwargs: engine settings (``model_path``, ``compute_type``) or
            transport credentials, depending on the route.
    """

    name: str = "transcription"
    description: str = "Transcribes recorded speech into text."
    model: str = ""
    route: str = DEFAULT_TRANSCRIPTION_ROUTE
    language: str = ""
    max_audio_bytes: int = DEFAULT_MAX_AUDIO_BYTES
    model_kwargs: dict[str, Any] = Field(default_factory=dict)

    async def run(self, input: TranscriptionInput) -> TranscriptionOutput:
        audio = input.audio or b""
        if not audio:
            raise TranscriptionError(
                "A transcription request needs audio.", kind="bad_request"
            )

        limit = max(1, int(self.max_audio_bytes or DEFAULT_MAX_AUDIO_BYTES))
        if len(audio) > limit:
            raise TranscriptionError(
                f"The recording is too long to transcribe in one request "
                f"({len(audio)} bytes, limit {limit}).",
                kind="too_long",
            )

        route = self.route or DEFAULT_TRANSCRIPTION_ROUTE
        adapter = get_transcription_adapter(route)

        # The block's settings are defaults a request may override.
        request = input.model_copy(update={
            "language": input.language or self.language,
        })

        result = await adapter(self.model, request, dict(self.model_kwargs or {}))

        # An empty transcript is a real answer -- the user may have recorded
        # silence -- so it is returned rather than raised, and the caller
        # decides how to present "nothing was heard".
        result.route = route
        return result
