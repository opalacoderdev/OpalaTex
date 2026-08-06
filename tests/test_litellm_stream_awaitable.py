import pytest

from agenticblocks.blocks.llm.agent import LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
import agenticblocks.blocks.llm.agent as agent_module
import agenticblocks.blocks.llm.memgpt_agent as memgpt_module


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_class", "module"),
    [
        (LLMAgentBlock, agent_module),
        (MemGPTAgentBlock, memgpt_module),
    ],
)
async def test_acompletion_awaits_nested_litellm_result(monkeypatch, agent_class, module):
    expected_response = object()

    async def nested_response():
        return expected_response

    async def fake_acompletion(**_kwargs):
        return nested_response()

    monkeypatch.setattr(module.litellm, "acompletion", fake_acompletion)
    agent = agent_class(name="test-agent", model="test-model", use_shared_router=False)

    response = await agent._acompletion(
        [{"role": "user", "content": "hello"}],
        stream=False,
    )

