"""Attachment utilities: document extraction and image compression for chat uploads."""
from __future__ import annotations

import base64
import io
import os
import re
import tempfile
import zipfile
import xml.etree.ElementTree as ET


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _truncate(text: str, max_chars: int | None) -> str:
    if max_chars is not None and len(text) > max_chars:
        return text[:max_chars]
    return text


def _guess_mime(filename: str, mime: str) -> str:
    """Return a useful MIME type even when the browser sends an empty value."""
    normalized = (mime or "").lower()
    if normalized and normalized != "application/octet-stream":
        return normalized
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".pdf":
        return "application/pdf"
    if ext == ".docx":
        return DOCX_MIME
    if ext == ".pptx":
        return PPTX_MIME
    return normalized or "application/octet-stream"


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

    return _truncate(md_text, max_chars)


def _read_zip_xml(data_b64: str, member_names: list[str]) -> list[ET.Element]:
    raw = base64.b64decode(data_b64)
    roots: list[ET.Element] = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in member_names:
            try:
                roots.append(ET.fromstring(archive.read(name)))
            except KeyError:
                continue
    return roots


def _xml_text(root: ET.Element) -> str:
    pieces: list[str] = []
    paragraph_break_tags = {"p", "tr"}
    line_break_tags = {"br", "cr"}
    tab_tags = {"tab"}

    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "t" and element.text:
            pieces.append(element.text)
        elif tag in tab_tags:
            pieces.append("\t")
        elif tag in line_break_tags:
            pieces.append("\n")
        elif tag in paragraph_break_tags:
            if pieces and not pieces[-1].endswith("\n"):
                pieces.append("\n")

    text = "".join(pieces)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def extract_docx_text(data_b64: str, max_chars: int | None = None) -> str:
    """Decode a base64-encoded DOCX and extract its visible document text."""
    roots = _read_zip_xml(data_b64, ["word/document.xml"])
    text = "\n\n".join(_xml_text(root) for root in roots).strip()
    return _truncate(text, max_chars)


def extract_pptx_text(data_b64: str, max_chars: int | None = None) -> str:
    """Decode a base64-encoded PPTX and extract slide text in slide order."""
    raw = base64.b64decode(data_b64)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        slide_names = [
            name for name in archive.namelist()
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ]
        slide_names.sort(key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)))
        roots = [ET.fromstring(archive.read(name)) for name in slide_names]

    slides = []
    for idx, root in enumerate(roots, start=1):
        text = _xml_text(root).strip()
        if text:
            slides.append(f"Slide {idx}:\n{text}")
    return _truncate("\n\n".join(slides), max_chars)


def extract_document_text(
    data_b64: str,
    mime: str,
    filename: str = "",
    max_chars: int | None = None,
) -> str:
    """Extract text from supported document uploads."""
    normalized_mime = _guess_mime(filename, mime)
    if normalized_mime == "application/pdf":
        return extract_pdf_text(data_b64, max_chars=max_chars)
    if normalized_mime == DOCX_MIME:
        return extract_docx_text(data_b64, max_chars=max_chars)
    if normalized_mime == PPTX_MIME:
        return extract_pptx_text(data_b64, max_chars=max_chars)
    raise ValueError(f"Unsupported document type: {mime or filename or 'unknown'}")


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
    For documents: extracts text and returns type="pdf_text".
    Unknown types: returned as-is with type="unknown".

    Returns:
        {"type": ..., "data": ..., "mime": ..., "name": filename}
    """
    normalized_mime = _guess_mime(filename, mime)
    if normalized_mime in {"application/pdf", DOCX_MIME, PPTX_MIME}:
        text = extract_document_text(data_b64, normalized_mime, filename, max_chars=max_chars)
        return {
            "type": "pdf_text",
            "data": text,
            "raw_data": data_b64,
            "raw_mime": normalized_mime,
            "mime": normalized_mime,
            "name": filename,
        }

    if normalized_mime.startswith("image/"):
        compressed = compress_image(data_b64, normalized_mime)
        return {"type": "image", "data": compressed, "mime": "image/jpeg", "name": filename}

    # Fallback: pass raw data through unchanged
    return {"type": "unknown", "data": data_b64, "mime": normalized_mime, "name": filename}
