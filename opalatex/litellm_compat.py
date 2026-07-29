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

    agent_name = str(getattr(agent, "name", "") or "")
    if agent_name == "worker" or agent_name.startswith("skill_"):
        object.__setattr__(agent, "use_shared_router", False)

    original: Callable[..., Any] = agent._acompletion
    original_run: Callable[..., Any] | None = getattr(agent, "run", None)

    async def _acompletion_with_compat(messages: list[dict[str, Any]], **kwargs: Any) -> Any:
        if agent_name == "worker" or agent_name.startswith("skill_"):
            object.__setattr__(agent, "use_shared_router", False)
        model = getattr(agent, "model", "") or kwargs.get("model", "")
        kwargs = sanitize_litellm_kwargs_for_model(model, kwargs)
        kwargs.setdefault("drop_params", True)
        sanitize_agent_state(agent)
        
        cleaned_messages = sanitize_tool_call_messages(messages)
        if _has_repeated_tool_validation_errors(cleaned_messages):
            cleaned_messages = cleaned_messages + [{
                "role": "system",
                "content": (
                    "SYSTEM ALERT: Repeated invalid tool-call arguments were detected. "
                    "Stop attempting tool calls for this turn. You MUST call send_message "
                    "with request_heartbeat=false and briefly tell the user that the active "
                    "model failed to produce valid tool arguments for the requested action."
                ),
            }]
            if _tool_name_available(getattr(agent, "tools", []), "send_message"):
                kwargs["tool_choice"] = {"type": "function", "function": {"name": "send_message"}}
        
        try:
            res = await original(cleaned_messages, **kwargs)
            # If it's a ChatCompletion object or model response
            if hasattr(res, "choices") and res.choices:
                choice = res.choices[0]
                msg = getattr(choice, "message", None)
                if msg:
                    tcalls = getattr(msg, "tool_calls", None)
                    if tcalls and isinstance(tcalls, list):
                        new_tcalls = []
                        has_split = False
                        for tc in tcalls:
                            fn = getattr(tc, "function", None)
                            if not fn:
                                new_tcalls.append(tc)
                                continue
                            args_str = getattr(fn, "arguments", "")
                            objs = split_concatenated_json(args_str)
                            if len(objs) > 1:
                                has_split = True
                                import uuid
                                from litellm import ChatCompletionMessageToolCall, Function
                                for obj in objs:
                                    original_name = getattr(fn, "name", "") or ""
                                    agent_tools = getattr(agent, "tools", [])
                                    if tool_accepts_args(original_name, obj, agent_tools):
                                        matched_name = original_name
                                    else:
                                        matched_name = find_tool_for_args(obj, agent_tools) or original_name or "unknown"
                                    new_tc = ChatCompletionMessageToolCall(
                                        id=str(uuid.uuid4()),
                                        type="function",
                                        function=Function(
                                            name=matched_name,
                                            arguments=json.dumps(obj)
                                        )
                                    )
                                    new_tcalls.append(new_tc)
                            else:
                                new_tcalls.append(tc)
                        if has_split:
                            msg.tool_calls = new_tcalls
            return res
        except Exception as e:
            normalized = _normalize_ollama_unexpected_response_error(e)
            if normalized is not e:
                raise normalized from e
            raise

    async def _run_with_compat(*args: Any, **kwargs: Any) -> Any:
        sanitize_agent_state(agent)
        return await original_run(*args, **kwargs)

    object.__setattr__(agent, "_acompletion", _acompletion_with_compat)
    if original_run is not None:
        object.__setattr__(agent, "run", _run_with_compat)
    object.__setattr__(agent, "_opalatex_litellm_compat_wrapped", True)
    return agent


def _normalize_ollama_unexpected_response_error(exc: Exception) -> Exception:
    """Replace noisy Ollama/LiteLLM response-shape errors with a useful hint."""
    text = str(exc)
    low = text.lower()
    if (
        "ollama" not in low
        or "keyerror" not in low
        or "'message'" not in text
        or "unexpected response from ollama" not in low
    ):
        return exc

    detail = "Ollama returned an unexpected response instead of a chat message."
    if "internal server error" in low:
        detail = (
            "Ollama returned HTTP 500 (Internal Server Error) instead of a chat "
            "message."
        )

    message = (
        f"{detail} Check that the Ollama server is healthy, the selected model "
        "supports the requested chat/tool/thinking features, and the model "
        "parameters are supported. Original LiteLLM error: "
        f"{_truncate_for_error(text, 500)}"
    )
    try:
        return exc.__class__(message)
    except Exception:
        return RuntimeError(message)


def _truncate_for_error(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


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


def split_concatenated_json(s: str) -> list[dict]:
    import json
    decoder = json.JSONDecoder()
    objs = []
    s = s.strip()
    while s:
        try:
            obj, idx = decoder.raw_decode(s)
            objs.append(obj)
            s = s[idx:].strip()
        except json.JSONDecodeError:
            break
    return objs


def find_tool_for_args(args_dict: dict, tools: list) -> str | None:
    keys = set(args_dict.keys())
    candidates = []
    for tool in tools:
        tool_name = getattr(tool, "name", None)
        if not tool_name:
            continue
        schema = _tool_schema_fields(tool)
        if schema is None:
            continue
        fields, required = schema
        if keys and keys <= fields and required <= keys:
            candidates.append(tool_name)
    return candidates[0] if len(candidates) == 1 else None


def tool_accepts_args(tool_name: str, args_dict: dict, tools: list) -> bool:
    if not tool_name:
        return False
    keys = set(args_dict.keys())
    if not keys:
        return False
    for tool in tools:
        if getattr(tool, "name", None) != tool_name:
            continue
        schema = _tool_schema_fields(tool)
        if schema is None:
            return False
        fields, required = schema
        return keys <= fields and required <= keys
    return False


def _has_repeated_tool_validation_errors(messages: list[dict[str, Any]], *, threshold: int = 2) -> bool:
    seen: dict[str, int] = {}
    for msg in reversed(messages[-12:]):
        if msg.get("role") != "tool":
            continue
        content = str(msg.get("content") or "")
        if "validation error" not in content and "validation errors" not in content:
            continue
        if "Field required" not in content and "Input should be" not in content:
            continue
        name = str(msg.get("name") or "unknown")
        seen[name] = seen.get(name, 0) + 1
        if seen[name] >= threshold:
            return True
    return False


def _tool_name_available(tools: list, name: str) -> bool:
    return any(getattr(tool, "name", None) == name for tool in tools)


def _tool_schema_fields(tool: Any) -> tuple[set[str], set[str]] | None:
    input_schema_fn = getattr(tool, "input_schema", None)
    if not input_schema_fn:
        return None
    try:
        schema_cls = input_schema_fn()
        if hasattr(schema_cls, "model_json_schema"):
            schema = schema_cls.model_json_schema()
            return set(schema.get("properties", {}).keys()), set(schema.get("required", []))
        if hasattr(schema_cls, "model_fields"):
            fields = set(schema_cls.model_fields.keys())
            required = {
                name for name, field in schema_cls.model_fields.items()
                if getattr(field, "is_required", lambda: False)()
            }
            return fields, required
        if hasattr(schema_cls, "__fields__"):
            fields = set(schema_cls.__fields__.keys())
            required = {
                name for name, field in schema_cls.__fields__.items()
                if getattr(field, "required", False)
            }
            return fields, required
    except Exception:
        return None
    return None
