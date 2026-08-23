"""Image generation adapters and their registry.

An adapter turns a provider-neutral :class:`ImageGenerationInput` into calls
against one transport and returns :class:`ImageArtifact` objects. Two ship with
the framework:

``images_api``
    The OpenAI Images contract (``POST /v1/images/generations``), dispatched
    through LiteLLM. One adapter covers OpenAI, Azure, Gemini/Imagen, Vertex,
    Bedrock, Stability, Recraft, fal.ai, OpenRouter and Black Forest Labs, plus
    *any* OpenAI-compatible server reachable through ``api_base`` -- LocalAI,
    Docker Model Runner, vLLM-Omni, or an Ollama build that serves the route.
    Adding such a server is a catalog entry, not code.

``chat_multimodal``
    Chat completions that return images alongside text (``modalities=["text",
    "image"]``), which is how ``gemini-*-flash-image`` and similar models do
    conversational/iterative generation. The Images API cannot express "change
    the figure you just made"; this route can.

Register more with :func:`register_image_adapter` -- a transport LiteLLM does
not cover (a native NDJSON endpoint, a diffusion server with its own schema)
plugs in without touching :class:`ImageGenerationBlock`.
"""

from __future__ import annotations

import base64
from typing import Any, Awaitable, Callable, Protocol

from agenticblocks.blocks.image.types import (
    ImageArtifact,
    ImageGenerationError,
    ImageGenerationInput,
)

# Transport kwargs an adapter may forward to the provider. Chat parameters
# (temperature, num_ctx, think, stream, tools, …) are meaningless to an image
# endpoint and are rejected by several of them, so callers pass credentials and
# nothing else.
TRANSPORT_KWARGS = ("api_key", "api_base", "api_version", "timeout", "extra_headers")


class ImageAdapter(Protocol):
    """Callable that produces images for one transport."""

    async def __call__(
        self,
        model: str,
        request: ImageGenerationInput,
        model_kwargs: dict[str, Any],
    ) -> list[ImageArtifact]:
        ...


_ADAPTERS: dict[str, ImageAdapter] = {}


def register_image_adapter(route: str, adapter: ImageAdapter) -> None:
    """Register *adapter* under *route*, replacing any previous registration."""
    if not route:
        raise ValueError("route must be a non-empty string")
    _ADAPTERS[route] = adapter


def get_image_adapter(route: str) -> ImageAdapter:
    try:
        return _ADAPTERS[route]
    except KeyError:
        raise ImageGenerationError(
            f"Unknown image generation route '{route}'. Available routes: "
            f"{', '.join(sorted(_ADAPTERS)) or '(none registered)'}.",
            kind="unknown_route",
        ) from None


def available_image_routes() -> list[str]:
    return sorted(_ADAPTERS)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Read *key* from a dict or an attribute of a model object."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _decode_data_uri(url: str) -> tuple[str, str]:
    """Split a ``data:`` URI into (base64 payload, mime). Returns ("", "") otherwise."""
    if not url.startswith("data:"):
        return "", ""
    header, _, payload = url.partition(",")
    if not payload:
        return "", ""
    mime = header[5:].split(";")[0]
    if ";base64" not in header:
        # A non-base64 data URI (percent-encoded text, e.g. inline SVG).
        from urllib.parse import unquote

        payload = base64.b64encode(unquote(payload).encode("utf-8")).decode("ascii")
    return payload, mime


def _transport_kwargs(model_kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v
        for k, v in (model_kwargs or {}).items()
        if k in TRANSPORT_KWARGS and v not in (None, "")
    }


def _raise_from_litellm(exc: Exception, model: str) -> None:
    """Re-raise a LiteLLM exception as a classified ImageGenerationError."""
    try:
        import litellm
    except ImportError:  # pragma: no cover - litellm is a hard dependency in practice
        raise ImageGenerationError(str(exc), kind="unknown") from exc

    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, litellm.exceptions.AuthenticationError):
        raise ImageGenerationError(
            f"Authentication failed for image model '{model}'. {detail}", kind="auth"
        ) from exc
    if isinstance(exc, litellm.exceptions.APIConnectionError):
        raise ImageGenerationError(
            f"Could not reach the image endpoint for '{model}'. {detail}",
            kind="connection",
        ) from exc
    if isinstance(exc, litellm.exceptions.NotFoundError):
        # A 404 on /v1/images/generations means the server has no such route --
        # the shape an Ollama build without image support returns.
        raise ImageGenerationError(
            f"The endpoint serving '{model}' has no image generation route. {detail}",
            kind="unsupported",
        ) from exc
    if isinstance(exc, litellm.exceptions.BadRequestError):
        raise ImageGenerationError(
            f"The provider rejected the image request for '{model}'. {detail}",
            kind="bad_request",
        ) from exc
    raise ImageGenerationError(
        f"Image generation failed for '{model}'. {detail}", kind="unknown"
    ) from exc


# ─── images_api: the OpenAI Images contract ───────────────────────────────────

async def images_api_adapter(
    model: str,
    request: ImageGenerationInput,
    model_kwargs: dict[str, Any],
) -> list[ImageArtifact]:
    import litellm

    kwargs: dict[str, Any] = _transport_kwargs(model_kwargs)
    kwargs["n"] = max(1, int(request.n or 1))
    if request.size:
        kwargs["size"] = request.size
    if request.negative_prompt:
        kwargs["negative_prompt"] = request.negative_prompt
    if request.seed is not None:
        kwargs["seed"] = int(request.seed)
    kwargs.update(request.extra_params or {})

    try:
        response = await litellm.aimage_generation(
            model=model, prompt=request.prompt, **kwargs
        )
    except Exception as exc:  # noqa: BLE001 - classified and re-raised below
        _raise_from_litellm(exc, model)
        raise  # unreachable, keeps type checkers happy

    artifacts: list[ImageArtifact] = []
    for item in _get(response, "data", None) or []:
        b64 = _get(item, "b64_json", "") or ""
        url = _get(item, "url", "") or ""
        mime = ""
        if not b64 and url:
            b64, mime = _decode_data_uri(url)
            if b64:
                url = ""
        artifacts.append(
            ImageArtifact(
                data_b64=b64,
                url=url,
                mime=mime,
                revised_prompt=_get(item, "revised_prompt", "") or "",
                seed=request.seed,
            )
        )
    return artifacts


# ─── chat_multimodal: images returned by a chat completion ────────────────────

def _artifacts_from_message(message: Any) -> list[ImageArtifact]:
    artifacts: list[ImageArtifact] = []

    # LiteLLM surfaces generated images as message.images, each an OpenAI-style
    # {"image_url": {"url": "data:image/png;base64,…"}} item.
    for entry in _get(message, "images", None) or []:
        url = _get(_get(entry, "image_url", {}) or {}, "url", "") or ""
        b64, mime = _decode_data_uri(url)
        if b64:
            artifacts.append(ImageArtifact(data_b64=b64, mime=mime))
        elif url:
            artifacts.append(ImageArtifact(url=url))

    # Some providers put the image in the content parts instead.
    content = _get(message, "content", None)
    if isinstance(content, list):
        for part in content:
            if _get(part, "type", "") != "image_url":
                continue
            url = _get(_get(part, "image_url", {}) or {}, "url", "") or ""
            b64, mime = _decode_data_uri(url)
            if b64:
                artifacts.append(ImageArtifact(data_b64=b64, mime=mime))
            elif url:
                artifacts.append(ImageArtifact(url=url))

    return artifacts


async def chat_multimodal_adapter(
    model: str,
    request: ImageGenerationInput,
    model_kwargs: dict[str, Any],
) -> list[ImageArtifact]:
    import litellm

    kwargs: dict[str, Any] = _transport_kwargs(model_kwargs)
    kwargs.update(request.extra_params or {})

    prompt = request.prompt
    if request.negative_prompt:
        prompt = f"{prompt}\n\nAvoid: {request.negative_prompt}"

    messages = list(_get(request.extra_params or {}, "messages", None) or [])
    kwargs.pop("messages", None)
    if not messages:
        messages = [{"role": "user", "content": prompt}]

    try:
        response = await litellm.acompletion(
            model=model,
            messages=messages,
            modalities=["text", "image"],
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 - classified and re-raised below
        _raise_from_litellm(exc, model)
        raise  # unreachable

    artifacts: list[ImageArtifact] = []
    for choice in _get(response, "choices", None) or []:
        artifacts.extend(_artifacts_from_message(_get(choice, "message", None)))
    return artifacts


register_image_adapter("images_api", images_api_adapter)
register_image_adapter("chat_multimodal", chat_multimodal_adapter)
