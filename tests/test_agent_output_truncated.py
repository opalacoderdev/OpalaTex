"""AgentOutput.truncated: an answer cut off at the output-token limit says so.

A reply that stopped mid-sentence reads exactly like a finished one, so a host
showing it as complete presents a partial result as a whole. LiteLLM normalizes
every provider's stop reason to ``finish_reason == "length"`` for that case.
"""
import asyncio
from types import SimpleNamespace

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.core.function_block import as_tool


def _response(content="", tool_calls=None, finish_reason="stop"):
    message = SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)], usage=None)


@as_tool
def lookup(term: str) -> str:
    """Look a term up."""
    return f"{term}: found"


def _run(agent, script):
    calls = []

    async def fake_acompletion(messages, **_kw):
        calls.append(1)
        return script[len(calls) - 1]

    agent._acompletion = fake_acompletion
    return asyncio.run(agent.run(AgentInput(prompt="q")))


def test_a_final_answer_cut_at_the_token_limit_is_truncated():
    agent = LLMAgentBlock(name="t", model="ollama_chat/test", system_prompt="s")
    out = _run(agent, [_response("The Amazon is a", finish_reason="length")])

    assert out.final_text == "The Amazon is a"
    assert out.truncated is True


def test_a_finished_answer_is_not_truncated():
    agent = LLMAgentBlock(name="t", model="ollama_chat/test", system_prompt="s")
    out = _run(agent, [_response("Done.")])

    assert out.truncated is False


def test_a_response_without_a_finish_reason_is_not_truncated():
    agent = LLMAgentBlock(name="t", model="ollama_chat/test", system_prompt="s")
    message = SimpleNamespace(content="Done.", tool_calls=None, reasoning_content=None)
    out = _run(agent, [SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)])

    assert out.truncated is False


def test_the_forced_final_answer_after_the_tool_budget_reports_truncation():
    agent = LLMAgentBlock(
        name="t", model="ollama_chat/test", system_prompt="s", tools=[lookup], max_tool_calls=1,
    )
    call = SimpleNamespace(
        id="c1", type="function", function=SimpleNamespace(name="lookup", arguments='{"term": "x"}'),
    )
    out = _run(agent, [
        _response("", tool_calls=[call]),
        _response("Partial", finish_reason="length"),
    ])

    assert out.budget_exhausted is True
    assert out.truncated is True


def test_the_truncation_of_an_earlier_tool_call_step_does_not_leak_into_the_answer():
    """Only the completion that produced final_text decides."""
    agent = LLMAgentBlock(
        name="t", model="ollama_chat/test", system_prompt="s", tools=[lookup], max_tool_calls=3,
    )
    call = SimpleNamespace(
        id="c1", type="function", function=SimpleNamespace(name="lookup", arguments='{"term": "x"}'),
    )
    out = _run(agent, [
        _response("", tool_calls=[call], finish_reason="length"),
        _response("Complete answer."),
    ])

    assert out.final_text == "Complete answer."
    assert out.truncated is False
