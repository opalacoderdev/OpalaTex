"""MemGPTAgentBlock.append_external_messages: turns that happened elsewhere."""

import pytest

from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock


def agent(history=None):
    block = MemGPTAgentBlock(name="a", system_prompt="s", model="ollama/test")
    block.internal_history = list(history or [])
    return block


def test_appends_in_order_after_the_restored_history():
    block = agent([{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}])

    count = block.append_external_messages([
        {"role": "user", "content": "elsewhere"},
        {"role": "assistant", "content": "answered elsewhere"},
    ])

    assert count == 2
    assert block.internal_history[-2:] == [
        {"role": "user", "content": "elsewhere"},
        {"role": "assistant", "content": "answered elsewhere"},
    ]


def test_extra_keys_are_not_carried_into_the_request():
    block = agent()

    block.append_external_messages([{"role": "user", "content": "x", "timestamp": "t", "device": "phone"}])

    assert block.internal_history == [{"role": "user", "content": "x"}]


@pytest.mark.parametrize("message", [
    {"role": "system", "content": "x"},
    {"role": "tool", "content": "x", "tool_call_id": "1"},
    {"role": "user", "content": [{"type": "text", "text": "x"}]},
    "not a mapping",
])
def test_anything_but_plain_text_turns_is_refused_and_nothing_is_appended(message):
    block = agent([{"role": "user", "content": "hello"}])

    with pytest.raises(ValueError):
        block.append_external_messages([{"role": "user", "content": "ok"}, message])

    assert block.internal_history == [{"role": "user", "content": "hello"}]


def test_an_unanswered_tool_call_blocks_the_append():
    history = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}},
        ]},
    ]
    block = agent(history)

    assert block.append_external_messages([{"role": "user", "content": "x"}]) == 0
    assert block.internal_history == history


def test_the_appended_turns_are_part_of_the_dumped_state():
    block = agent()
    block.append_external_messages([{"role": "user", "content": "x"}])

    restored = agent()
    restored.load_state(block.dump_state())

    assert restored.internal_history == [{"role": "user", "content": "x"}]
