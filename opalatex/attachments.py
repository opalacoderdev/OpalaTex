"""Attachment utilities: PDF extraction and image compression for chat uploads."""
from __future__ import annotations

import base64
import io
import os
import tempfile


def extract_pdf_text(data_b64: str, max_chars: int | None = None) -> str:
    """Decode a base64-encoded PDF and extract its content as Markdown.

    Uses pymupdf4llm, which preserves headings, tables, and code blocks —
    producing much richer output for LLM consumption than plain-text extractors.

    Args:
        data_b64: Base64-encoded PDF bytes.
        max_chars: If set, truncate the output to this many characters.

    Returns:
        Markdown string representation of the PDF content.
    """
    import pymupdf4llm  # type: ignore

    raw = base64.b64decode(data_b64)
    # pymupdf4llm.to_markdown() requires a file path, not a buffer.
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        md_text: str = pymupdf4llm.to_markdown(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if max_chars is not None and len(md_text) > max_chars:
        md_text = md_text[:max_chars]

    return md_text


def compress_image(data_b64: str, mime: str, max_side: int = 1024) -> str:
    """Resize an image to fit within max_side × max_side and re-encode as JPEG.

    Args:
        data_b64: Base64-encoded image bytes.
        mime: Original MIME type (e.g. "image/png").
        max_side: Maximum pixel length for the longest dimension.

    Returns:
        Base64-encoded JPEG string (without data-URL prefix).
    """
    from PIL import Image  # type: ignore

    raw = base64.b64decode(data_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def build_attachment_descriptor(
    filename: str,
    data_b64: str,
    mime: str,
    *,
    max_chars: int | None = None,
) -> dict:
    """Convert a raw upload into a normalised attachment descriptor.

    For images: compresses and returns type="image".
    For PDFs: extracts Markdown text and returns type="pdf_text".
    Unknown types: returned as-is with type="unknown".

    Returns:
        {"type": ..., "data": ..., "mime": ..., "name": filename}
    """
    if mime == "application/pdf":
        text = extract_pdf_text(data_b64, max_chars=max_chars)
        return {"type": "pdf_text", "data": text, "mime": mime, "name": filename}

    if mime.startswith("image/"):
        compressed = compress_image(data_b64, mime)
        return {"type": "image", "data": compressed, "mime": "image/jpeg", "name": filename}

    # Fallback: pass raw data through unchanged
    return {"type": "unknown", "data": data_b64, "mime": mime, "name": filename}
