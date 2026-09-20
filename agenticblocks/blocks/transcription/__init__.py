"""Speech-to-text blocks."""

from agenticblocks.blocks.transcription.adapters import (
    TranscriptionAdapter,
    available_transcription_routes,
    clear_cache,
    get_transcription_adapter,
    load_whisper_model,
    local_whisper_adapter,
    register_transcription_adapter,
    transcribe_sync,
)
from agenticblocks.blocks.transcription.transcribe import (
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_TRANSCRIPTION_ROUTE,
    TranscriptionBlock,
)
from agenticblocks.blocks.transcription.types import (
    TranscriptionError,
    TranscriptionInput,
    TranscriptionOutput,
)

__all__ = [
    "DEFAULT_MAX_AUDIO_BYTES",
    "DEFAULT_TRANSCRIPTION_ROUTE",
    "TranscriptionAdapter",
    "TranscriptionBlock",
    "TranscriptionError",
    "TranscriptionInput",
    "TranscriptionOutput",
    "available_transcription_routes",
    "clear_cache",
    "get_transcription_adapter",
    "load_whisper_model",
    "local_whisper_adapter",
    "register_transcription_adapter",
    "transcribe_sync",
]
