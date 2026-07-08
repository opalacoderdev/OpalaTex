"""Compatibility helpers for LiteLLM/OpenAI chat requests."""
from __future__ import annotations

import json
from typing import Any, Callable

from opalatex.config import sanitize_litellm_kwargs_for_model


def sanitize_tool_call_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return messages with OpenAI tool-call adjacency repaired.

    OpenAI-compatible endpoints reject a request when an assistant message with
    ``tool_calls`` is not immediately followed by one ``tool`` message for each
    call id. Long-running agent histories can become malformed after an aborted
    turn, context eviction, or provider/tool parsing failure. This function keeps
    valid tool-call/result pairs intact, but downgrades incomplete tool-call
    records to plain assistant text so the provider never receives an orphaned
    function call id.
    """
    cleaned: list[dict[str, Any]] = []
    idx = 0

    while idx < len(messages):
        msg = dict(messages[idx] or {})

        if msg.get("role") != "assistant" or not msg.get("tool_calls"):
            if msg.get("role") == "tool":
                cleaned.append(_orphan_tool_as_user_message(msg))
            else:
                cleaned.append(msg)
            idx += 1
            continue

        tool_calls = [
            tc for tc in msg.get("tool_calls") or []
            if isinstance(tc, dict) and tc.get("id")
        ]
        if not tool_calls:
            msg.pop("tool_calls", None)
            cleaned.append(msg)
            idx += 1
            continue

        expected_ids = [tc["id"] for tc in tool_calls]
        expected = set(expected_ids)
        seen: set[str] = set()
        buffered_tool_messages: list[dict[str, Any]] = []
        orphan_tool_messages: list[dict[str, Any]] = []
        idx += 1

        while idx < len(messages) and (messages[idx] or {}).get("role") == "tool":
            tool_msg = dict(messages[idx] or {})
            tool_call_id = tool_msg.get("tool_call_id")
            if tool_call_id in expected and tool_call_id not in seen:
                buffered_tool_messages.append(tool_msg)
                seen.add(tool_call_id)
            else:
                orphan_tool_messages.append(tool_msg)
            idx += 1

        by_id = {m.get("tool_call_id"): m for m in buffered_tool_messages}
        previous_role = _previous_conversation_role(cleaned)
        has_valid_turn_order = previous_role in {"user", "tool"}
        has_all_expected_outputs = expected <= set(by_id)
        if not has_all_expected_outputs or not has_valid_turn_order:
            cleaned.append(_assistant_tool_calls_as_text(msg, tool_calls))
            for tool_msg in buffered_tool_messages + orphan_tool_messages:
                cleaned.append(_orphan_tool_as_user_message(tool_msg))
            continue

        cleaned.append(msg)
        for tool_call in tool_calls:
            tool_call_id = tool_call["id"]
            cleaned.append(by_id[tool_call_id])
        for orphan in orphan_tool_messages:
            cleaned.append(_orphan_tool_as_user_message(orphan))

    return cleaned


def wrap_agent_litellm_compat(agent: Any) -> Any:
    """Patch an AgenticBlocks agent instance to sanitize messages before LiteLLM."""
    if getattr(agent, "_opalatex_litellm_compat_wrapped", False):
        return agent

    original: Callable[..., Any] = agent._acompletion
    original_run: Callable[..., Any] | None = getattr(agent, "run", None)

    async def _acompletion_with_compat(messages: list[dict[str, Any]], **kwargs: Any) -> Any:
        model = getattr(agent, "model", "") or kwargs.get("model", "")
        kwargs = sanitize_litellm_kwargs_for_model(model, kwargs)
        kwargs.setdefault("drop_params", True)
        sanitize_agent_state(agent)
        return await original(sanitize_tool_call_messages(messages), **kwargs)

    async def _run_with_compat(*args: Any, **kwargs: Any) -> Any:
        sanitize_agent_state(agent)
        return await original_run(*args, **kwargs)

    object.__setattr__(agent, "_acompletion", _acompletion_with_compat)
    if original_run is not None:
        object.__setattr__(agent, "run", _run_with_compat)
    object.__setattr__(agent, "_opalatex_litellm_compat_wrapped", True)
    return agent


def sanitize_agent_state(agent: Any) -> None:
    """Repair persisted agent state and provider-incompatible tool settings."""
    _disable_tool_role_workaround_for_native_tool_providers(agent)
    _sanitize_agent_history_in_place(agent)


def _previous_conversation_role(messages: list[dict[str, Any]]) -> str | None:
    for msg in reversed(messages):
        role = msg.get("role")
        if role != "system":
            return role
    return None


def _sanitize_agent_history_in_place(agent: Any) -> None:
    history = getattr(agent, "internal_history", None)
    if isinstance(history, list):
        sanitized = sanitize_tool_call_messages(history)
        if sanitized != history:
            history[:] = sanitized


def _disable_tool_role_workaround_for_native_tool_providers(agent: Any) -> None:
    model = (getattr(agent, "model", "") or "").lower()
    provider = model.split("/", 1)[0] if "/" in model else ""
    model_kargs = getattr(agent, "model_kargs", None) or getattr(agent, "model_kwargs", None) or {}
    custom_provider = str(model_kargs.get("custom_llm_provider", "")).lower()
    if provider in {"ollama", "ollama_chat"}:
        return
    if custom_provider in {"ollama", "ollama_chat"}:
        return
    if getattr(agent, "tool_role_workaround", None):
        object.__setattr__(agent, "tool_role_workaround", None)


def _orphan_tool_as_user_message(msg: dict[str, Any]) -> dict[str, str]:
    name = msg.get("name") or "unknown"
    content = msg.get("content") or ""
    return {
        "role": "user",
        "content": f"[Recovered orphan tool result from '{name}']\n{content}",
    }


def _assistant_tool_calls_as_text(
    msg: dict[str, Any],
    tool_calls: list[dict[str, Any]],
) -> dict[str, str]:
    content = msg.get("content") or ""
    summaries = []
    for tool_call in tool_calls:
        fn = tool_call.get("function") or {}
        name = fn.get("name") or "unknown"
        args = fn.get("arguments") or ""
        summaries.append(f"- {name}: {args}")
    recovered = "[Recovered incomplete assistant tool call; removed before provider request]"
    if summaries:
        recovered += "\n" + "\n".join(summaries)
    if content:
        recovered = f"{content}\n\n{recovered}"
    return {"role": "assistant", "content": recovered}
