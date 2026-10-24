"""LLMAgentBlock.final_answer_prompt: the forced final call is told why it is final.

When the tool or iteration budget is spent the block makes one more call with
the tools withdrawn. Without saying so, a model mid-research took that call for
another research step and answered with a tool call (observed with
ollama_chat/glm-5.3-flash:cloud), so the run ended with no answer.
"""
import asyncio
from types import SimpleNamespace

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.core.function_block import as_tool

NOTICE = "Budget spent. Answer now."


@as_tool
def lookup(term: str) -> str:
    """Look a term up."""
    return f"{term}: found"


def _response(content="", tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")], usage=None)


def _call(call_id, term):
    return SimpleNamespace(
        id=call_id, type="function",
        function=SimpleNamespace(name="lookup", arguments=f'{{"term": "{term}"}}'),
    )


def _run(agent, script):
    sent = []

    async def fake_acompletion(messages, **kwargs):
        sent.append({"messages": [dict(m) for m in messages], "kwargs": kwargs})
        return script[len(sent) - 1]

    agent._acompletion = fake_acompletion
    return asyncio.run(agent.run(AgentInput(prompt="q"))), sent


def test_the_tool_budget_final_call_carries_the_notice():
    agent = LLMAgentBlock(
        name="t", model="ollama_chat/test", system_prompt="s",
        tools=[lookup], max_tool_calls=1, final_answer_prompt=NOTICE,
    )
    out, sent = _run(agent, [_response(tool_calls=[_call("c1", "a")]), _response("The answer.")])

    assert out.final_text == "The answer."
    assert sent[-1]["messages"][-1] == {"role": "system", "content": NOTICE}
    assert "tools" not in sent[-1]["kwargs"]


def test_the_iteration_budget_final_call_carries_the_notice():
    agent = LLMAgentBlock(
        name="t", model="ollama_chat/test", system_prompt="s", tools=[lookup],
        max_tool_calls=10, max_iterations=1, on_max_iterations="return_last",
        final_answer_prompt=NOTICE,
    )
    out, sent = _run(agent, [_response(tool_calls=[_call("c1", "a")]), _response("The answer.")])

    assert out.final_text == "The answer."
    assert sent[-1]["messages"][-1] == {"role": "system", "content": NOTICE}


def test_without_a_notice_the_final_call_is_unchanged():
    """The default keeps every existing caller's request exactly as it was."""
    agent = LLMAgentBlock(name="t", model="ollama_chat/test", system_prompt="s", tools=[lookup], max_tool_calls=1)
    _out, sent = _run(agent, [_response(tool_calls=[_call("c1", "a")]), _response("The answer.")])

    assert sent[-1]["messages"][-1]["role"] == "tool"


def test_a_run_that_never_spends_its_budget_never_sees_the_notice():
    agent = LLMAgentBlock(
        name="t", model="ollama_chat/test", system_prompt="s",
        tools=[lookup], max_tool_calls=5, final_answer_prompt=NOTICE,
    )
    _out, sent = _run(agent, [_response(tool_calls=[_call("c1", "a")]), _response("The answer.")])

    assert all(m.get("content") != NOTICE for call in sent for m in call["messages"])
