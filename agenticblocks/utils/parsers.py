import json
import re
from typing import Any, Dict, List, Optional, Tuple

def extract_json_plan(text: str) -> Optional[Dict[str, Any]]:
    """
    Extracts a JSON object from a string, parsing markdown code blocks or raw JSON.
    Returns None if no valid JSON object is found.
    """
    if not text:
        return None
    text = text.strip()
    candidates = []

    if "```" in text:
        for p in text.split("```"):
            p = p.strip()
            if p.startswith("json"):
                p = p[4:].strip()
            if p.startswith("{"):
                candidates.append(p)
    
    if text.startswith("{"):
        candidates.append(text)
        
    if "{" in text and "}" in text:
        candidates.append(text[text.find("{"): text.rfind("}") + 1])

    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
            
    return None


_THINK_OPEN_RE = re.compile(r"<think>", re.IGNORECASE)
_THINK_CLOSE_RE = re.compile(r"</think>", re.IGNORECASE)
_THINK_PAIR_RE = re.compile(r"<think>(.*?)</think>", re.IGNORECASE | re.DOTALL)


def split_inline_reasoning_parts(content: Optional[str]) -> Tuple[List[str], str]:
    """Split reasoning a model wrote inside the content channel.

    Returns ``(reasoning_parts, visible)``, where ``reasoning_parts`` holds each
    reasoning section in the order it appeared.

    Two shapes are recognised:

    - **Balanced blocks** — ``<think>…</think>`` anywhere in the text. Every block
      is collected as reasoning and removed from the visible text.
    - **An orphan closing tag** — reasoning terminated by ``</think>`` with no
      opening tag before it. Chat templates for several reasoning models seed the
      opening ``<think>`` at the end of the prompt, so the model only ever
      generates the closing one; everything before it is reasoning, not an answer.

    A ``</think>`` that appears *after* an opening tag is left to the balanced
    pass: a model writing well-formed tags is not producing orphans.
    """
    text = str(content or "")
    if not text:
        return [], ""

    reasoning_parts: List[str] = []

    first_open = _THINK_OPEN_RE.search(text)
    first_close = _THINK_CLOSE_RE.search(text)
    if first_close and (first_open is None or first_close.start() < first_open.start()):
        prefix = text[: first_close.start()].strip()
        if prefix:
            reasoning_parts.append(prefix)
        text = text[first_close.end():]

    def _collect(match: "re.Match[str]") -> str:
        inner = match.group(1).strip()
        if inner:
            reasoning_parts.append(inner)
        return "\n"

    visible = _THINK_PAIR_RE.sub(_collect, text)
    return reasoning_parts, visible.strip()


def split_inline_reasoning(content: Optional[str]) -> Tuple[str, str]:
    """``split_inline_reasoning_parts`` with the reasoning sections joined.

    Returns ``(reasoning, visible)``.
    """
    parts, visible = split_inline_reasoning_parts(content)
    return "\n\n".join(parts).strip(), visible
