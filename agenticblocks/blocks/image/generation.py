"""ImageGenerationBlock: one block, several image APIs.

The block owns validation, adapter dispatch and result normalisation; each
transport lives in an adapter (see :mod:`agenticblocks.blocks.image.adapters`).
Callers therefore write the same code whether the image comes from OpenAI,
Gemini, a Stability endpoint or a diffusion server running on localhost --
only ``model``, ``route`` and ``model_kwargs["api_base"]`` change.
"""

from __future__ import annotations

import asyncio
from typing import Any

from pydantic import Field

from agenticblocks.blocks.image.adapters import get_image_adapter
from agenticblocks.blocks.image.types import (
    ImageArtifact,
    ImageGenerationError,
    ImageGenerationInput,
    ImageGenerationOutput,
    sniff_image_mime,
)
from agenticblocks.core.block import Block

DEFAULT_IMAGE_ROUTE = "images_api"


class ImageGenerationBlock(Block[ImageGenerationInput, ImageGenerationOutput]):
    """Generate images from a text prompt through a pluggable transport.

    Args:
        model: provider-qualified model id, e.g. ``"gemini/imagen-4.0-generate-001"``
            or ``"openai/stable-diffusion"`` pointed at a local server.
        route: adapter name; ``"images_api"`` (default) or ``"chat_multimodal"``.
        model_kwargs: transport credentials only (``api_key``, ``api_base``,
            ``timeout``, …). Chat sampling parameters do not belong here.
    """

    name: str = "image_generation"
    description: str = "Generates images from a text prompt."
    model: str = ""
    route: str = DEFAULT_IMAGE_ROUTE
    model_kwargs: dict[str, Any] = Field(default_factory=dict)

    async def run(self, input: ImageGenerationInput) -> ImageGenerationOutput:
        if not (self.model or "").strip():
            raise ImageGenerationError(
                "No image generation model configured.", kind="not_configured"
            )
        if not (input.prompt or "").strip():
            raise ImageGenerationError(
                "An image generation prompt cannot be empty.", kind="bad_request"
            )

        adapter = get_image_adapter(self.route or DEFAULT_IMAGE_ROUTE)
        artifacts = await adapter(self.model, input, dict(self.model_kwargs or {}))

        artifacts = [a for a in artifacts if a.has_bytes() or a.url]
        if not artifacts:
            raise ImageGenerationError(
                f"Model '{self.model}' returned no image for this prompt.",
                kind="empty",
            )

        return ImageGenerationOutput(
            images=artifacts, model=self.model, route=self.route or DEFAULT_IMAGE_ROUTE
        )


async def resolve_image_bytes(artifact: ImageArtifact, timeout: float = 120.0) -> tuple[bytes, str]:
    """Return ``(bytes, mime)`` for *artifact*, fetching a remote URL if needed.

    OpenAI returns a URL by default while Gemini and local servers return inline
    base64, so callers that just want the pixels would otherwise need to handle
    both. The MIME type is sniffed from the bytes rather than trusted from the
    provider: the extension written to disk has to match the real format.
    """
    if artifact.has_bytes():
        data = artifact.to_bytes()
    else:
        url = artifact.url or ""
        if not url.startswith(("http://", "https://")):
            raise ImageGenerationError(
                f"Refusing to fetch image from unsupported URL scheme: {url[:32]!r}",
                kind="bad_request",
            )
        data = await asyncio.to_thread(_fetch_url, url, timeout)

    if not data:
        raise ImageGenerationError("The generated image is empty.", kind="empty")

    return data, (sniff_image_mime(data) or artifact.mime or "image/png")


def _fetch_url(url: str, timeout: float) -> bytes:
    from urllib import error as urllib_error
    from urllib import request as urllib_request

    try:
        with urllib_request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except urllib_error.URLError as exc:
        raise ImageGenerationError(
            f"Could not download the generated image: {exc}", kind="connection"
        ) from exc
