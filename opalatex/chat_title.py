"""Automatic chat title generation on first leave.

When a user creates a chat without changing its default placeholder name, has a
conversation in it, and leaves that chat for the first time (switches to another
chat, opens a new chat, closes the chat panel, switches project, or exits), this
module generates a short, descriptive title from the conversation transcript and
renames the chat once.

The generation runs through an ephemeral AgenticBlocks ``LLMAgentBlock`` that
answers in **plain text** (same rationale as ``opalatex.translation`` and prompt
evolution: a JSON envelope adds a failure mode when the entire result is one
short string). The project's ``user_prompt_prefix`` is deliberately **not**
applied so standing chat instructions cannot leak into or override the title.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Same rationale as PROMPT_EVOLUTION_REASONING_EFFORT: a short title does not
# need full reasoning depth, and "low" rather than "none" keeps Ollama thinking
# models separating reasoning from the final answer channel.
CHAT_TITLE_REASONING_EFFORT = "low"

MAX_TITLE_CHARS = 80
MAX_TRANSCRIPT_CHARS = 4000
MAX_MESSAGE_CHARS = 800
CHAT_TITLE_MAX_TOKENS = 1024

_LABEL_PREFIX_RE = re.compile(
    r"^(?:title|chat\s+title|subject|topic|t[ií]tulo|assunto|tema)\s*:\s*",
    re.IGNORECASE,
)
_LEADING_MARKUP_RE = re.compile(r"^(?:#+\s+|(?:[-•]|\*(?!\*))\s+)+")


def build_chat_title_system_prompt() -> str:
    return (
        "You generate a short, descriptive title for a chat conversation.\n"
        "Read the conversation excerpt provided by the user and summarize its "
        "main topic as a concise title of 3 to 7 words (maximum 60 characters).\n"
        "Write the title in the same language used by the user in the conversation.\n"
        "Answer with the title as plain text on a single line and nothing else: "
        "no preamble, no labels like 'Title:', no quotes, no markdown, no code "
        "fences, and no trailing period.\n"
        "Do not think out loud in your answer: no restatement of these "
        "instructions and no explanation of how you chose the title."
    )


def _truncate_message(text: str, limit: int) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(1, limit - 1)].rstrip() + "…"


def format_conversation_for_title(
    messages: list[dict],
    *,
    max_chars: int = MAX_TRANSCRIPT_CHARS,
    max_message_chars: int = MAX_MESSAGE_CHARS,
) -> str:
    """Format visible user/assistant turns into a bounded plain-text excerpt.

    Keeps the opening turns (which usually state the goal) and, when the
    conversation is long, appends the most recent turns within *max_chars*.
    """
    entries: list[str] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        content = _truncate_message(msg.get("content", ""), max_message_chars)
        if not content:
            continue
        label = "User" if role == "user" else "Assistant"
        entries.append(f"{label}: {content}")

    if not entries:
        return ""

    full = "\n".join(entries)
    if len(full) <= max_chars:
        return full

    # Keep the opening context and include the latest turns when space allows.
    head_budget = max(200, int(max_chars * 0.65))
    head: list[str] = []
    head_len = 0
    head_count = 0
    for entry in entries:
        cost = len(entry) + (1 if head else 0)
        if head and head_len + cost > head_budget:
            break
        head.append(entry[:head_budget] if not head and cost > head_budget else entry)
        head_len += len(head[-1]) + (1 if len(head) > 1 else 0)
        head_count += 1

    remaining_entries = entries[head_count:]
    separator = "\n...\n"
    tail_budget = max_chars - head_len - len(separator)
    tail: list[str] = []
    tail_len = 0
    if remaining_entries and tail_budget > 80:
        for entry in reversed(remaining_entries):
            cost = len(entry) + (1 if tail else 0)
            if tail_len + cost > tail_budget:
                break
            tail.append(entry)
            tail_len += cost
        tail.reverse()

    if tail:
        return "\n".join(head) + separator + "\n".join(tail)
    return "\n".join(head)[:max_chars].rstrip()


def clean_generated_title(raw: str, *, max_chars: int = MAX_TITLE_CHARS) -> str:
    """Extract a single clean title line from the model's raw response."""
    from opalatex.translation import strip_model_reasoning, strip_plain_text_wrapper

    answer = strip_model_reasoning(raw)
    if not answer and str(raw or "").strip():
        raise ValueError("The model answered with reasoning only and no chat title.")

    unwrapped = strip_plain_text_wrapper(answer)
    lines = [line.strip() for line in unwrapped.splitlines() if line.strip()]
    if not lines:
        raise ValueError("The model returned an empty chat title.")

    title = lines[0]
    title = _LEADING_MARKUP_RE.sub("", title).strip()
    title = _LABEL_PREFIX_RE.sub("", title).strip()

    # Strip paired surrounding quotes/backticks/bold markers repeatedly.
    pairs = (('"', '"'), ("'", "'"), ("`", "`"), ("«", "»"), ("“", "”"), ("**", "**"))
    changed = True
    while changed and title:
        changed = False
        for left, right in pairs:
            if title.startswith(left) and title.endswith(right) and len(title) >= len(left) + len(right):
                title = title[len(left) : len(title) - len(right)].strip()
                changed = True

    title = _LABEL_PREFIX_RE.sub("", title).strip()
    title = re.sub(r"\s+", " ", title).strip()
    title = title.rstrip(".:;").strip()

    if not title:
        raise ValueError("The model returned an empty chat title.")

    if len(title) > max_chars:
        cut = title[:max_chars].rstrip()
        if " " in cut and len(cut.rsplit(" ", 1)[0]) >= max_chars // 2:
            cut = cut.rsplit(" ", 1)[0].rstrip(" ,;:-")
        title = cut.rstrip(".:;").strip()

    if not title:
        raise ValueError("The model returned an empty chat title.")
    return title


async def generate_chat_title(
    messages: list[dict],
    *,
    model: str | None = None,
    api_key: str | None = None,
    api_base: str | None = None,
    max_tokens: int = CHAT_TITLE_MAX_TOKENS,
) -> str:
    """Generate a concise title for *messages* via an ephemeral ``LLMAgentBlock``."""
    transcript = format_conversation_for_title(messages)
    if not transcript:
        raise ValueError("Cannot generate a chat title from an empty conversation.")

    import agenticblocks.blocks.llm.agent as _agent_mod
    from opalatex.config import (
        get_agent_llm_kwargs,
        get_agent_model,
        normalize_ollama_api_base_for_litellm,
        resolve_model_route,
    )
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    selected_model = str(model or "").strip()
    model_kwargs = get_agent_llm_kwargs(
        "orchestrator",
        model_override=selected_model or None,
        reasoning_effort_override=CHAT_TITLE_REASONING_EFFORT,
    )
    if not selected_model:
        selected_model = get_agent_model("orchestrator")
    if not str(selected_model or "").strip():
        raise ValueError("No model is configured for chat title generation.")

    if api_base and not model_kwargs.get("api_base"):
        model_kwargs["api_base"] = api_base
    if api_key and not model_kwargs.get("api_key"):
        model_kwargs["api_key"] = api_key

    try:
        model_kwargs["max_tokens"] = max(32, min(4096, int(max_tokens)))
    except (TypeError, ValueError):
        model_kwargs["max_tokens"] = CHAT_TITLE_MAX_TOKENS

    selected_model = resolve_model_route(selected_model, model_kwargs)
    if model_kwargs.get("api_base"):
        model_kwargs["api_base"] = normalize_ollama_api_base_for_litellm(
            selected_model,
            model_kwargs["api_base"],
        )

    agent = _agent_mod.LLMAgentBlock(
        name="chat_auto_title",
        system_prompt=build_chat_title_system_prompt(),
        model=selected_model,
        model_kwargs=model_kwargs,
    )
    wrap_agent_litellm_compat(agent)
    res = await agent.run(_agent_mod.AgentInput(prompt=transcript))
    return clean_generated_title(res.response)


async def auto_title_chat(
    store,
    project_name: str,
    chat_id: str,
    *,
    model: str | None = None,
) -> dict:
    """Rename *chat_id* from its conversation subject if eligible on first leave.

    Returns a structured status dict:
    ``{"renamed": bool, "reason": str, "chat_id": str, "name": str | None, "auto_title_pending": bool}``.
    """
    from opalatex.project import resolve_chat_models

    original_name, reason = store.claim_auto_title(project_name, chat_id)
    if original_name is None:
        return {
            "renamed": False,
            "reason": reason,
            "chat_id": chat_id,
            "name": None,
            "auto_title_pending": reason == "no_messages",
        }

    project = store.load(project_name, chat_id=chat_id)
    if project is None:
        return {
            "renamed": False,
            "reason": "not_eligible",
            "chat_id": chat_id,
            "name": None,
            "auto_title_pending": False,
        }

    resolved_model = str(model or "").strip()
    if not resolved_model:
        resolution = resolve_chat_models(project)
        resolved_model = resolution.model

    title = await generate_chat_title(
        project.history or [],
        model=resolved_model or None,
        api_key=getattr(project, "api_key", None) or None,
        api_base=getattr(project, "api_base", None) or None,
    )

    applied = store.apply_auto_title(project_name, chat_id, original_name, title)
    if not applied:
        return {
            "renamed": False,
            "reason": "name_changed",
            "chat_id": chat_id,
            "name": None,
            "auto_title_pending": False,
        }

    return {
        "renamed": True,
        "reason": "renamed",
        "chat_id": chat_id,
        "name": title,
        "auto_title_pending": False,
    }
