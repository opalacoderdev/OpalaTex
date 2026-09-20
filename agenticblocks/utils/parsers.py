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


# Chat-template control tokens emitted by models whose harmony/channel format is
# passed through verbatim by the provider (gpt-oss served by Ollama, notably).
_CONTROL_MESSAGE_RE = re.compile(r"<\|message\|>", re.IGNORECASE)
_CONTROL_END_RE = re.compile(r"<\|end\|>", re.IGNORECASE)
_CONTROL_START_RE = re.compile(r"<\|start\|>[^<\r\n]*", re.IGNORECASE)
_CHANNEL_MARKER_RE = re.compile(
    r"<\|channel\|>\s*([A-Za-z0-9_-]+)\s*(?:<\|message\|>)?",
    re.IGNORECASE,
)

#: Channel names whose segments are reasoning, not an answer.
REASONING_CHANNEL_NAMES = frozenset({"thought", "analysis", "reasoning"})
#: Channel names whose segments are addressed to the user.
VISIBLE_CHANNEL_NAMES = frozenset({"final", "commentary", "assistant"})


def strip_chat_control_tokens(content: Optional[str]) -> str:
    """Remove raw chat-template control tokens from model output."""
    text = str(content or "")
    text = _CONTROL_MESSAGE_RE.sub("", text)
    text = _CONTROL_END_RE.sub("", text)
    text = _CONTROL_START_RE.sub("", text)
    return text.strip()


def split_channel_markup(content: Optional[str]) -> Tuple[List[str], str]:
    """Split channel markup *and* ``<think>`` tags into reasoning and answer.

    Returns ``(reasoning_parts, visible)``, the same shape as
    ``split_inline_reasoning_parts``, which this function falls back to when the
    text carries no ``<|channel|>`` markers. It is the widest splitter available:
    any caller that publishes model text to a user should route it through here,
    because a reasoning model reaches the content channel in either shape
    depending on whether the provider parsed the reasoning for us.

    An unknown channel name is treated as visible: dropping a segment because the
    channel is unrecognised would discard an answer, which is worse than showing
    one line too many.
    """
    text = str(content or "")
    matches = list(_CHANNEL_MARKER_RE.finditer(text))
    if not matches:
        return split_inline_reasoning_parts(text)

    visible_parts: List[str] = []
    reasoning_parts: List[str] = []
    if matches[0].start() > 0:
        visible_parts.append(strip_chat_control_tokens(text[: matches[0].start()]))

    for index, match in enumerate(matches):
        channel = match.group(1).lower()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        segment = strip_chat_control_tokens(text[match.end():end])
        if not segment:
            continue
        if channel in REASONING_CHANNEL_NAMES:
            reasoning_parts.append(segment)
        else:
            visible_parts.append(segment)

    embedded_reasoning, visible = split_inline_reasoning_parts(
        "\n\n".join(part for part in visible_parts if part)
    )
    return reasoning_parts + embedded_reasoning, visible
