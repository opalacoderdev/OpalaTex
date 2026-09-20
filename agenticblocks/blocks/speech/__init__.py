"""Speech synthesis blocks."""

from agenticblocks.blocks.speech.adapters import (
    DEFAULT_RESPONSE_FORMAT,
    DEFAULT_VOICE,
    TRANSPORT_KWARGS,
    SpeechAdapter,
    audio_speech_adapter,
    available_speech_routes,
    get_speech_adapter,
    read_audio_bytes,
    register_speech_adapter,
)
from agenticblocks.blocks.speech.local_onnx import (
    clear_cache,
    load_voice,
    local_onnx_adapter,
    phoneme_ids,
    synthesize_wav,
)
from agenticblocks.blocks.speech.phonemes import (
    Clause,
    PhonemizerError,
    availability_problem,
    install_hint,
    is_available,
    phonemize,
)
from agenticblocks.blocks.speech.synthesis import (
    DEFAULT_MAX_INPUT_CHARS,
    DEFAULT_SPEECH_ROUTE,
    SpeechSynthesisBlock,
)
from agenticblocks.blocks.speech.types import (
    SpeechArtifact,
    SpeechSynthesisError,
    SpeechSynthesisInput,
    SpeechSynthesisOutput,
    extension_for_audio_mime,
    mime_for_audio_format,
    sniff_audio_mime,
)

__all__ = [
    "Clause",
    "PhonemizerError",
    "availability_problem",
    "clear_cache",
    "install_hint",
    "is_available",
    "load_voice",
    "local_onnx_adapter",
    "phoneme_ids",
    "phonemize",
    "synthesize_wav",
    "DEFAULT_MAX_INPUT_CHARS",
    "DEFAULT_RESPONSE_FORMAT",
    "DEFAULT_SPEECH_ROUTE",
    "DEFAULT_VOICE",
    "TRANSPORT_KWARGS",
    "SpeechAdapter",
    "SpeechArtifact",
    "SpeechSynthesisBlock",
    "SpeechSynthesisError",
    "SpeechSynthesisInput",
    "SpeechSynthesisOutput",
    "audio_speech_adapter",
    "available_speech_routes",
    "extension_for_audio_mime",
    "get_speech_adapter",
    "mime_for_audio_format",
    "read_audio_bytes",
    "register_speech_adapter",
    "sniff_audio_mime",
]
