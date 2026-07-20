def test_sanitize_tool_call_messages_strips_incomplete_tool_call():
    from opalatex.litellm_compat import sanitize_tool_call_messages

    messages = [
        {"role": "user", "content": "Look at this image"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_missing",
                    "type": "function",
                    "function": {"name": "analyze_image", "arguments": "{}"},
                }
            ],
        },
        {"role": "user", "content": "What happened?"},
    ]

    sanitized = sanitize_tool_call_messages(messages)

    assert sanitized[1]["role"] == "assistant"
    assert "tool_calls" not in sanitized[1]
    assert "call_missing" not in sanitized[1]["content"]
    assert "analyze_image" in sanitized[1]["content"]
    assert sanitized[2]["role"] == "user"


def test_sanitize_tool_call_messages_converts_orphan_tool_message():
    from opalatex.litellm_compat import sanitize_tool_call_messages

    sanitized = sanitize_tool_call_messages([
        {"role": "tool", "name": "read_file", "tool_call_id": "call_old", "content": "ok"}
    ])

    assert sanitized == [
        {"role": "user", "content": "[Recovered orphan tool result from 'read_file']\nok"}
    ]


def test_sanitize_tool_call_messages_preserves_complete_tool_pair():
    from opalatex.litellm_compat import sanitize_tool_call_messages

    messages = [
        {"role": "user", "content": "read x"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_ok",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path":"x"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_ok", "name": "read_file", "content": "ok"},
        {"role": "user", "content": "continue"},
    ]

    assert sanitize_tool_call_messages(messages) == messages


def test_sanitize_tool_call_messages_strips_tool_call_with_invalid_turn_order():
    from opalatex.litellm_compat import sanitize_tool_call_messages

    messages = [
        {"role": "assistant", "content": "Previous assistant text"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_bad_order",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path":"x"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_bad_order", "name": "read_file", "content": "ok"},
    ]

    sanitized = sanitize_tool_call_messages(messages)

    assert sanitized[0] == messages[0]
    assert sanitized[1]["role"] == "assistant"
    assert "tool_calls" not in sanitized[1]
    assert "read_file" in sanitized[1]["content"]
    assert sanitized[2]["role"] == "user"
    assert "Recovered orphan tool result" in sanitized[2]["content"]


def test_sanitize_tool_call_messages_strips_tool_call_at_history_start():
    from opalatex.litellm_compat import sanitize_tool_call_messages

    sanitized = sanitize_tool_call_messages([
        {"role": "system", "content": "summary"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_at_start",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_at_start", "name": "read_file", "content": "ok"},
    ])

    assert sanitized[0]["role"] == "system"
    assert sanitized[1]["role"] == "assistant"
    assert "tool_calls" not in sanitized[1]
    assert sanitized[2]["role"] == "user"


def test_wrap_agent_litellm_compat_adds_drop_params(monkeypatch):
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    calls = {}

    class FakeAgent:
        model = "openai/gpt-5.5"

        async def _acompletion(self, messages, **kwargs):
            calls["messages"] = messages
            calls["kwargs"] = kwargs
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    result = asyncio.run(agent._acompletion([{"role": "user", "content": "hi"}]))

    assert result == "ok"
    assert calls["kwargs"]["drop_params"] is True


def test_wrap_agent_litellm_compat_sanitizes_runtime_kwargs():
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    calls = {}

    class FakeAgent:
        model = "openai/gpt-5.5"

        async def _acompletion(self, messages, **kwargs):
            calls["kwargs"] = kwargs
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    result = asyncio.run(agent._acompletion(
        [{"role": "user", "content": "hi"}],
        temperature=0.7,
        top_p=0.9,
        max_tokens=64,
    ))

    assert result == "ok"
    assert "temperature" not in calls["kwargs"]
    assert "top_p" not in calls["kwargs"]
    assert calls["kwargs"]["max_tokens"] == 64
    assert calls["kwargs"]["drop_params"] is True


def test_wrap_agent_litellm_compat_repairs_internal_history_in_place():
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    class FakeAgent:
        def __init__(self):
            self.internal_history = [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_stale",
                            "type": "function",
                            "function": {"name": "analyze_image", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "user", "content": "next question"},
            ]

        async def _acompletion(self, messages, **kwargs):
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    result = asyncio.run(agent._acompletion(list(agent.internal_history)))

    assert result == "ok"
    assert agent.internal_history[0]["role"] == "assistant"
    assert "tool_calls" not in agent.internal_history[0]
    assert "analyze_image" in agent.internal_history[0]["content"]
    assert agent.internal_history[1]["role"] == "user"


def test_wrap_agent_litellm_compat_disables_tool_role_workaround_for_openai():
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    calls = {}
    messages = [
        {"role": "user", "content": "read"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_ok",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_ok", "name": "read_file", "content": "ok"},
    ]

    class FakeAgent:
        model = "openai/gpt-5.5"
        tool_role_workaround = "user"

        async def _acompletion(self, messages, **kwargs):
            converted = []
            for msg in messages:
                msg = dict(msg)
                if self.tool_role_workaround and msg.get("role") == "tool":
                    msg["role"] = self.tool_role_workaround
                    msg.pop("tool_call_id", None)
                converted.append(msg)
            calls["messages"] = converted
            calls["tool_role_workaround"] = self.tool_role_workaround
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    result = asyncio.run(agent._acompletion(messages))

    assert result == "ok"
    assert calls["tool_role_workaround"] is None
    assert calls["messages"][2]["role"] == "tool"
    assert calls["messages"][2]["tool_call_id"] == "call_ok"


def test_wrap_agent_litellm_compat_keeps_tool_role_workaround_for_ollama():
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    calls = {}

    class FakeAgent:
        model = "ollama/gemma4:12b"
        tool_role_workaround = "user"

        async def _acompletion(self, messages, **kwargs):
            calls["tool_role_workaround"] = self.tool_role_workaround
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    result = asyncio.run(agent._acompletion([{"role": "user", "content": "hi"}]))

    assert result == "ok"
    assert calls["tool_role_workaround"] == "user"


def test_wrap_agent_litellm_compat_repairs_history_before_run():
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    class FakeAgent:
        model = "openai/gpt-5.5"
        tool_role_workaround = "user"

        def __init__(self):
            self.internal_history = [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_stale",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "user", "content": "continue"},
            ]

        async def _acompletion(self, messages, **kwargs):
            return "ok"

        async def run(self, input):
            assert self.tool_role_workaround is None
            assert "tool_calls" not in self.internal_history[0]
            return "ok"

    agent = wrap_agent_litellm_compat(FakeAgent())

    import asyncio

    assert asyncio.run(agent.run(object())) == "ok"


def test_find_tool_for_args_returns_none_when_schema_match_is_ambiguous():
    from agenticblocks.core.function_block import as_tool
    from opalatex.litellm_compat import find_tool_for_args

    @as_tool(name="run_command")
    def run_command(command: str) -> str:
        return command

    @as_tool(name="run_background_command")
    def run_background_command(command: str) -> str:
        return command

    assert find_tool_for_args(
        {"command": "npm run dev"},
        [run_command, run_background_command],
    ) is None


def test_find_tool_for_args_requires_complete_unique_schema_match():
    from agenticblocks.core.function_block import as_tool
    from opalatex.litellm_compat import find_tool_for_args

    @as_tool(name="read_file")
    def read_file(path: str) -> str:
        return path

    @as_tool(name="replace_content_range")
    def replace_content_range(path: str, start_pos: int, end_pos: int, content: str) -> str:
        return path

    assert find_tool_for_args(
        {"path": "main.tex", "start_pos": 2, "end_pos": 4, "content": "x"},
        [read_file, replace_content_range],
    ) == "replace_content_range"

    assert find_tool_for_args(
        {"path": "main.tex"},
        [read_file, replace_content_range],
    ) == "read_file"


def test_repeated_tool_validation_errors_are_detected():
    from opalatex.litellm_compat import _has_repeated_tool_validation_errors

    messages = [
        {
            "role": "tool",
            "name": "replace_content_range",
            "content": "3 validation errors for ReplaceContentRangeInput\npath\n  Field required",
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [],
        },
        {
            "role": "tool",
            "name": "replace_content_range",
            "content": "3 validation errors for ReplaceContentRangeInput\nstart_pos\n  Field required",
        },
    ]

    assert _has_repeated_tool_validation_errors(messages)


def test_single_tool_validation_error_does_not_trip_loop_breaker():
    from opalatex.litellm_compat import _has_repeated_tool_validation_errors

    messages = [
        {
            "role": "tool",
            "name": "replace_content_range",
            "content": "3 validation errors for ReplaceContentRangeInput\npath\n  Field required",
        },
    ]

    assert not _has_repeated_tool_validation_errors(messages)


def test_analyze_image_resanitizes_kwargs_for_final_model(monkeypatch):
    import opalatex.tools as tools

    calls = {}

    class FakeMessage:
        content = "image description"

    class FakeChoice:
        message = FakeMessage()

    class FakeResponse:
        choices = [FakeChoice()]

    class FakeSession:
        model = "openai/gpt-5.5"
        project_path = "/fake/path"
        model_params = {
            "num_ctx": 8192,
            "top_k": 40,
            "temperature": 0.2,
        }

    def fake_completion(**kwargs):
        calls.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(tools, "_PROJECT_SESSION", FakeSession())
    monkeypatch.setattr("litellm.completion", fake_completion)
    monkeypatch.setattr("opalatex.ui_settings.load_ui_settings", lambda: {"ai_provider": "local"})
    tools.set_recent_file_attachments({
        "input_file_0.jpg": {
            "type": "image",
            "data": "aGVsbG8=",
            "mime": "image/jpeg",
            "name": "input_file_0.jpg",
        }
    })

    raw = getattr(tools.analyze_image, "_func", None) or tools.analyze_image
    import asyncio

    result = asyncio.run(raw("input_file_0.jpg", "Describe"))

    assert result == "image description"
    assert calls["model"] == "openai/gpt-5.5"
    assert calls["drop_params"] is True
    assert "temperature" not in calls
    assert "num_ctx" not in calls
    assert "top_k" not in calls
