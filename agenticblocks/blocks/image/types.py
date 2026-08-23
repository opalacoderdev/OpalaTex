"""Shared types for image generation blocks.

The canonical shape here is the OpenAI Images response (``data[]`` with
``b64_json`` or ``url``), because that is what every mainstream provider and
every OpenAI-compatible local server already speaks. Adapters translate their
provider into these types; callers never see a provider-specific payload.
"""

from __future__ import annotations

import base64
from typing import Any

from pydantic import BaseModel, Field


class ImageGenerationError(RuntimeError):
    """Raised when an image cannot be produced.

    ``kind`` classifies the failure so callers can render an actionable message
    without parsing provider prose:

    - ``"not_configured"``  no model/route was given
    - ``"unknown_route"``   the requested adapter is not registered
    - ``"auth"``            credentials missing or rejected
    - ``"connection"``      the endpoint could not be reached
    - ``"bad_request"``     the provider rejected the request (model, size, …)
    - ``"unsupported"``     the endpoint exists but does not do image generation
    - ``"empty"``           the call succeeded but returned no image
    - ``"unknown"``         anything else
    """

    def __init__(self, message: str, kind: str = "unknown") -> None:
        super().__init__(message)
        self.kind = kind


class ImageArtifact(BaseModel):
    """One generated image, as bytes-in-base64 or as a URL to fetch.

    Providers differ on which of the two they return (OpenAI defaults to a URL,
    Gemini and most local servers return base64), so both are modelled and
    neither is silently converted into the other. Use
    :func:`agenticblocks.blocks.image.resolve_image_bytes` to obtain bytes
    regardless of which one arrived.
    """

    data_b64: str = ""
    url: str = ""
    mime: str = ""
    revised_prompt: str = ""
    seed: int | None = None

    def has_bytes(self) -> bool:
        return bool(self.data_b64)

    def to_bytes(self) -> bytes:
        """Decode the inline payload.

        Raises ``ImageGenerationError`` for a URL-only artifact instead of
        returning empty bytes: a caller that writes b"" to disk produces a file
        that looks like a successful generation and is not one.
        """
        if not self.data_b64:
            raise ImageGenerationError(
                "This image was returned as a URL, not as inline data. "
                "Use resolve_image_bytes() to fetch it.",
                kind="bad_request",
            )
        return base64.b64decode(self.data_b64)


class ImageGenerationInput(BaseModel):
    """Provider-neutral request.

    ``negative_prompt`` and ``seed`` are not part of the OpenAI Images API but
    are supported by most local servers (LocalAI, Docker Model Runner,
    vLLM-Omni) and by several hosted providers. They are forwarded only when
    set, so a provider that does not know them never receives them; one that
    receives them and refuses fails loudly rather than silently ignoring them.
    """

    prompt: str
    n: int = 1
    size: str = ""
    negative_prompt: str = ""
    seed: int | None = None
    extra_params: dict[str, Any] = Field(default_factory=dict)


class ImageGenerationOutput(BaseModel):
    images: list[ImageArtifact]
    model: str = ""
    route: str = ""


def sniff_image_mime(data: bytes) -> str:
    """Return the MIME type of *data* from its magic bytes, or "" if unknown.

    Neither the OpenAI Images response nor Gemini's ``inlineData`` reliably
    carries a content type, and the file extension written to disk has to match
    the actual bytes -- a PNG saved as .jpg breaks ``\\includegraphics``.
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"II*\x00" or data[:4] == b"MM\x00*":
        return "image/tiff"
    if data[:5] == b"<?xml" or data[:4] == b"<svg":
        return "image/svg+xml"
    return ""


def extension_for_mime(mime: str) -> str:
    """Return the file extension (with dot) conventionally used for *mime*."""
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/tiff": ".tiff",
        "image/svg+xml": ".svg",
    }.get(mime, ".png")
