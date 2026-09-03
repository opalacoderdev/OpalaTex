"""Helpers for building and inspecting chat-completion message lists."""

from typing import Any, Dict, Iterable, List, Optional


def build_user_content(prompt: str, attachments: Optional[Iterable[dict]] = None) -> Any:
    """Return the ``content`` of a user message, plain or multimodal.

    Without attachments the content is the prompt string, which is what every
    provider accepts. With attachments it becomes the multimodal parts list:
    the prompt first, then one part per attachment descriptor
    (``{type, data, mime, name}``). Images travel as ``image_url`` data URIs and
    extracted documents as extra text parts, so a model without vision still
    receives the document text.

    Every agent loop that accepts attachments builds this same shape, including
    the loops that inject a message mid-run, so the conversion lives here rather
    than being copied per block and drifting between them.
    """
    attachments = list(attachments or [])
    if not attachments:
        return prompt

    parts: List[dict] = [{"type": "text", "text": prompt}]
    for att in attachments:
        if att.get("type") == "image":
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{att['mime']};base64,{att['data']}"},
            })
        elif att.get("type") == "pdf_text":
            parts.append({
                "type": "text",
                "text": f"\n\n[Content of attached file '{att['name']}']:\n{att['data']}",
            })
    return parts


def history_accepts_user_message(history: List[Dict[str, Any]]) -> bool:
    """Return whether a new user/system message may be appended to ``history``.

    A tool call and its results are one indivisible unit: an assistant message
    carrying ``tool_calls`` must be followed by a ``tool`` message for each of
    those calls, and nothing else may come between them. Appending while a call
    is still unanswered produces a request the provider rejects, so a caller that
    inserts messages from outside the loop (see
    :class:`agenticblocks.blocks.llm.inbox.MessageInbox`) has to ask first.

    An empty history, or one whose tail is a plain message, always accepts.
    """
    answered_ids = set()
    for msg in reversed(history or []):
        msg = msg or {}
        role = msg.get("role")
        if role == "tool":
            call_id = msg.get("tool_call_id")
            if call_id is not None:
                answered_ids.add(call_id)
            continue
        if role == "assistant" and msg.get("tool_calls"):
            for call in msg.get("tool_calls") or []:
                call_id = _tool_call_id(call)
                # A call without an id cannot be matched to a result; treat the
                # unit as open rather than guessing it was answered.
                if call_id is None or call_id not in answered_ids:
                    return False
        return True
    return True


def _tool_call_id(call: Any) -> Optional[str]:
    """Return a tool call's id, whether it is a dict or a provider object."""
    if isinstance(call, dict):
        return call.get("id")
    return getattr(call, "id", None)
