"""MemGPTAgentBlock with an unknown context window manages nothing on its own.

``max_context_tokens=None`` is how a caller says it cannot learn the model's
real window. Evicting or warning against an invented size would cut the
conversation where the provider never would, so the block leaves the history
whole and lets the provider decide whether a request fits.
"""
import asyncio
from types import SimpleNamespace

from agenticblocks.blocks.llm.agent import AgentInput
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock


def _answer(content):
    message = SimpleNamespace(content=content, tool_calls=None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _run(agent):
    requests = []

    async def fake_acompletion(messages, **kw):
        requests.append(messages)
        return _answer("Done.")

    async def no_summary(_messages):
        raise AssertionError("nothing may be evicted when the window is unknown")

    agent._acompletion = fake_acompletion
    agent._summarize = no_summary
    asyncio.run(agent.run(input=AgentInput(prompt="go")))
    return requests


def _long_history():
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": "word " * 2000}
        for i in range(40)
    ]


def test_unknown_window_neither_evicts_nor_warns():
    agent = MemGPTAgentBlock(name="orchestrator", system_prompt="s", max_context_tokens=None)
    agent.internal_history = _long_history()

    requests = _run(agent)

    assert len(agent.internal_history) >= 40
    assert not any(
        "SYSTEM ALERT: Memory Pressure" in str(m.get("content", ""))
        for m in requests[0] if m.get("role") == "system"
    )


def test_known_window_still_warns_under_pressure():
    agent = MemGPTAgentBlock(
        name="orchestrator", system_prompt="s",
        # ~80K tokens of history: past half of 100K, short of the whole window.
        max_context_tokens=100_000, eviction_threshold=1.0, memory_pressure_threshold=0.5,
    )
    agent.internal_history = _long_history()

    requests = _run(agent)

    assert any(
        "SYSTEM ALERT: Memory Pressure" in str(m.get("content", ""))
        for m in requests[0] if m.get("role") == "system"
    )
