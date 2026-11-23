"""Tool messages omit the non-standard ``name`` key on the wire.

OpenAI's Chat Completions ``ChatCompletionToolMessageParam`` schema defines
only ``role``, ``tool_call_id``, and ``content``. Sending ``name`` on a
``role: "tool"`` message causes strict OpenAI-compatible gateways backed by
Anthropic Messages to reject the request with
``messages[i].name: anthropic-messages cannot preserve named conversation
participants``. Stored history keeps ``name`` for diagnostics, compaction
transcripts, and validation-error tracking; the request copy sent to LiteLLM
strips it.
"""
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from litellm.llms.anthropic.chat.transformation import AnthropicConfig
from litellm.llms.ollama.chat.transformation import OllamaChatConfig
from litellm.llms.openai.chat.gpt_transformation import OpenAIGPTConfig
from litellm.llms.vertex_ai.gemini.transformation import _gemini_convert_messages_with_history
from openai.types.chat import ChatCompletionToolMessageParam

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from agenticblocks.core.function_block import as_tool
from opalatex.litellm_compat import wrap_agent_litellm_compat


ALLOWED_OPENAI_TOOL_KEYS = set(ChatCompletionToolMessageParam.__annotations__.keys())


def _history_with_tool_names():
    return [
        {"role": "system", "content": "System"},
        {"role": "system", "content": "Recursive Summary of older messages: None"},
        {"role": "user", "content": "What time is it?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_time", "arguments": '{"tz": "UTC"}'},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "get_time",
            "content": "12:00 UTC",
        },
    ]


def _make_tool_call_response(call_id="call_1", name="get_time", arguments='{"tz": "UTC"}'):
    tc = SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )
    msg = SimpleNamespace(content="", tool_calls=[tc], reasoning_content=None)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason="tool_calls")],
        usage=None,
    )


def _make_text_response(text="It is 12:00 UTC."):
    msg = SimpleNamespace(content=text, tool_calls=None, reasoning_content=None)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason="stop")],
        usage=None,
    )


@pytest.mark.parametrize("agent_class", [LLMAgentBlock, MemGPTAgentBlock])
@pytest.mark.asyncio
async def test_acompletion_strips_name_from_tool_messages_without_mutating_history(
    agent_class, monkeypatch
):
    captured = []

    async def fake_acompletion(**kwargs):
        captured.append(copy.deepcopy(kwargs["messages"]))
        return SimpleNamespace(choices=[])

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)
    agent = agent_class(
        name="test",
        model="openai/claude-sonnet-4-6",
        use_shared_router=False,
    )
    history = _history_with_tool_names()
    original = copy.deepcopy(history)

    await agent._acompletion(history)

    assert history == original
    sent = captured[0]
    assert sent[4]["role"] == "tool"
    assert "name" not in sent[4]
    assert set(sent[4].keys()) <= ALLOWED_OPENAI_TOOL_KEYS

    wire = OpenAIGPTConfig().transform_request(
        "openai/claude-sonnet-4-6", copy.deepcopy(sent), {}, {}, {}
    )
    assert "name" not in wire["messages"][4]
    assert set(wire["messages"][4].keys()) <= ALLOWED_OPENAI_TOOL_KEYS


@pytest.mark.asyncio
async def test_memgpt_run_tool_round_sends_openai_valid_tool_message_and_keeps_history_name(
    monkeypatch,
):
    captured = []
    responses = [_make_tool_call_response(), _make_text_response()]

    async def fake_acompletion(**kwargs):
        captured.append(copy.deepcopy(kwargs["messages"]))
        return responses.pop(0)

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    @as_tool(name="get_time", description="Return the current time.")
    def get_time(tz: str) -> str:
        return f"12:00 {tz}"

    agent = MemGPTAgentBlock(
        name="orchestrator",
        model="openai/claude-sonnet-4-6",
        tools=[get_time],
        use_shared_router=False,
    )
    result = await agent.run(AgentInput(prompt="What time is it?"))

    assert result.response == "It is 12:00 UTC."
    assert len(captured) == 2

    # Second completion carries messages[4] as the tool result (after system, summary, user, assistant).
    second_request = captured[1]
    assert second_request[4]["role"] == "tool"
    assert "name" not in second_request[4]
    assert second_request[4]["tool_call_id"] == "call_1"

    wire = OpenAIGPTConfig().transform_request(
        "openai/claude-sonnet-4-6", copy.deepcopy(second_request), {}, {}, {}
    )
    assert "name" not in wire["messages"][4]

    # Stored internal_history retains the tool name for compaction and diagnostics.
    stored_tool_msgs = [m for m in agent.internal_history if m.get("role") == "tool"]
    assert len(stored_tool_msgs) == 1
    assert stored_tool_msgs[0]["name"] == "get_time"


@pytest.mark.asyncio
async def test_llm_agent_run_tool_round_sends_openai_valid_tool_message(monkeypatch):
    captured = []
    responses = [_make_tool_call_response(), _make_text_response()]

    async def fake_acompletion(**kwargs):
        captured.append(copy.deepcopy(kwargs["messages"]))
        return responses.pop(0)

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    @as_tool(name="get_time", description="Return the current time.")
    def get_time(tz: str) -> str:
        return f"12:00 {tz}"

    agent = LLMAgentBlock(
        name="worker",
        model="openai/claude-sonnet-4-6",
        tools=[get_time],
        use_shared_router=False,
    )
    result = await agent.run(AgentInput(prompt="What time is it?"))

    assert result.response == "It is 12:00 UTC."
    assert len(captured) == 2

    second_request = captured[1]
    tool_msgs = [m for m in second_request if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert "name" not in tool_msgs[0]
    assert set(tool_msgs[0].keys()) <= ALLOWED_OPENAI_TOOL_KEYS


@pytest.mark.asyncio
async def test_wrap_agent_litellm_compat_tracks_validation_errors_before_wire_strip(
    monkeypatch,
):
    captured = []

    async def fake_acompletion(**kwargs):
        captured.append(copy.deepcopy(kwargs))
        return SimpleNamespace(choices=[])

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    agent = MemGPTAgentBlock(
        name="orchestrator",
        model="openai/claude-sonnet-4-6",
        use_shared_router=False,
    )
    wrap_agent_litellm_compat(agent)

    messages = [
        {"role": "system", "content": "System"},
        {"role": "user", "content": "Search"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "search_code", "arguments": "{}"}},
                {"id": "c2", "type": "function", "function": {"name": "search_code", "arguments": "{}"}},
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "c1",
            "name": "search_code",
            "content": "1 validation error\nquery\n Field required",
        },
        {
            "role": "tool",
            "tool_call_id": "c2",
            "name": "search_code",
            "content": "1 validation error\nquery\n Field required",
        },
    ]
    tools = [
        {"type": "function", "function": {"name": "search_code"}},
        {"type": "function", "function": {"name": "read_file"}},
    ]

    await agent._acompletion(messages, tools=tools)

    sent = captured[0]
    # Repeated-validation breaker saw the tool name and disabled only search_code.
    assert [t["function"]["name"] for t in sent["tools"]] == ["read_file"]
    # Yet the wire messages sent to LiteLLM carry no 'name' on any tool message.
    tool_msgs = [m for m in sent["messages"] if m.get("role") == "tool"]
    assert len(tool_msgs) == 2
    assert all("name" not in m for m in tool_msgs)


def test_stripped_tool_messages_remain_valid_across_provider_transforms():
    from agenticblocks.utils.messages import strip_tool_message_names

    history = _history_with_tool_names()
    stripped = strip_tool_message_names(history)

    assert "name" in history[4]
    assert "name" not in stripped[4]

    # OpenAI: valid ChatCompletionToolMessageParam keys only.
    openai_body = OpenAIGPTConfig().transform_request("gpt-4o", copy.deepcopy(stripped), {}, {}, {})
    assert "name" not in openai_body["messages"][4]

    # Anthropic: native tool_result paired by tool_use_id.
    anthropic_body = AnthropicConfig().transform_request(
        "claude-3-5-sonnet-20241022", copy.deepcopy(stripped), {}, {}, {}
    )
    tool_result_block = anthropic_body["messages"][-1]["content"][0]
    assert tool_result_block["type"] == "tool_result"
    assert tool_result_block["tool_use_id"] == "call_1"

    # Gemini: recovers function_response.name from the matching assistant tool_call.
    gemini_contents = _gemini_convert_messages_with_history(copy.deepcopy(stripped))
    fn_response = gemini_contents[-1]["parts"][0]["function_response"]
    assert fn_response["name"] == "get_time"

    # Ollama native chat: valid tool message.
    ollama_body = OllamaChatConfig().transform_request(
        "ollama_chat/llama3", copy.deepcopy(stripped), {}, {}, {}
    )
    assert ollama_body["messages"][-1]["role"] == "tool"


def test_strip_tool_message_names_leaves_non_tool_messages_untouched():
    from agenticblocks.utils.messages import strip_tool_message_names

    messages = [
        {"role": "user", "name": "alice", "content": "hi"},
        {"role": "assistant", "name": "bot", "content": "hello"},
        {"role": "tool", "tool_call_id": "c1", "name": "echo", "content": "ok"},
    ]
    original = copy.deepcopy(messages)
    cleaned = strip_tool_message_names(messages)

    assert messages == original
    assert cleaned[0] == {"role": "user", "name": "alice", "content": "hi"}
    assert cleaned[1] == {"role": "assistant", "name": "bot", "content": "hello"}
    assert cleaned[2] == {"role": "tool", "tool_call_id": "c1", "content": "ok"}
