"""Image generation blocks."""

from agenticblocks.blocks.image.adapters import (
    ImageAdapter,
    available_image_routes,
    chat_multimodal_adapter,
    get_image_adapter,
    images_api_adapter,
    register_image_adapter,
)
from agenticblocks.blocks.image.generation import (
    DEFAULT_IMAGE_ROUTE,
    ImageGenerationBlock,
    resolve_image_bytes,
)
from agenticblocks.blocks.image.types import (
    ImageArtifact,
    ImageGenerationError,
    ImageGenerationInput,
    ImageGenerationOutput,
    extension_for_mime,
    sniff_image_mime,
)

__all__ = [
    "DEFAULT_IMAGE_ROUTE",
    "ImageAdapter",
    "ImageArtifact",
    "ImageGenerationBlock",
    "ImageGenerationError",
    "ImageGenerationInput",
    "ImageGenerationOutput",
    "available_image_routes",
    "chat_multimodal_adapter",
    "extension_for_mime",
    "get_image_adapter",
    "images_api_adapter",
    "register_image_adapter",
    "resolve_image_bytes",
    "sniff_image_mime",
]
