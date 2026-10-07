"""Tool results name an id on the wire only when their assistant calls do.

LiteLLM's ``ollama_chat/`` transform drops ``id`` from assistant tool calls but
forwarded ``tool_call_id`` on tool results; mistral-large-4 on ollama.com rejected
that with ``Unexpected tool call id <id> in tool results``.
"""
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from litellm.llms.ollama.chat.transformation import OllamaChatConfig

from agenticblocks.blocks.llm.agent import LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from agenticblocks.utils.messages import match_tool_result_ids_to_route


def _history(user_content='Times?'):
    return [
        {'role': 'system', 'content': 'System'},
        {'role': 'user', 'content': user_content},
        {'role': 'assistant', 'content': '', 'tool_calls': [
            {'id': 'call-a', 'type': 'function', 'function': {'name': 'get_time', 'arguments': '{"tz": "UTC"}'}},
            {'id': 'call-b', 'type': 'function', 'function': {'name': 'get_time', 'arguments': '{"tz": "Asia/Tokyo"}'}},
        ]},
        {'role': 'tool', 'tool_call_id': 'call-a', 'name': 'get_time', 'content': '12:00'},
        {'role': 'tool', 'tool_call_id': 'call-b', 'name': 'get_time', 'content': '21:00'},
    ]


async def _sent(agent_class, model, history, monkeypatch):
    provider = AsyncMock(return_value=SimpleNamespace(choices=[]))
    monkeypatch.setattr('litellm.acompletion', provider)
    agent = agent_class(name='test', model=model, use_shared_router=False)
    await agent._acompletion(history)
    return provider.call_args.kwargs['model'], provider.call_args.kwargs['messages']


@pytest.mark.parametrize('agent_class', [LLMAgentBlock, MemGPTAgentBlock])
@pytest.mark.asyncio
async def test_ollama_chat_results_lose_the_id_their_calls_lost(agent_class, monkeypatch):
    history = _history()
    original = copy.deepcopy(history)
    model, sent = await _sent(agent_class, 'ollama_chat/mistral-large-4:cloud', history, monkeypatch)

    assert model == 'ollama_chat/mistral-large-4:cloud'
    tool_results = [m for m in sent if m['role'] == 'tool']
    assert [m['content'] for m in tool_results] == ['12:00', '21:00']
    assert all('tool_call_id' not in m for m in tool_results)
    assert sent[2] == original[2]
    assert history == original

    body = OllamaChatConfig().transform_request(model, sent, {}, {}, {})
    wire = [m for m in body['messages'] if m['role'] in ('assistant', 'tool')]
    assert all('id' not in call for call in wire[0]['tool_calls'])
    assert all('tool_call_id' not in m for m in wire[1:])


@pytest.mark.parametrize('agent_class', [LLMAgentBlock, MemGPTAgentBlock])
@pytest.mark.parametrize('model', ['ollama/mistral-large-4:cloud', 'openai/gpt-test', 'gemini/gemini-test'])
@pytest.mark.asyncio
async def test_routes_that_keep_call_ids_keep_result_ids(agent_class, model, monkeypatch):
    history = _history()
    _, sent = await _sent(agent_class, model, history, monkeypatch)
    assert sent[2:] == _history()[2:]


@pytest.mark.asyncio
async def test_image_reroute_to_openai_compatible_route_keeps_ids(monkeypatch):
    image = [{'type': 'text', 'text': 'Times?'},
             {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}]
    model, sent = await _sent(LLMAgentBlock, 'ollama_chat/vision-test', _history(image), monkeypatch)
    assert model == 'ollama/vision-test'
    assert [m.get('tool_call_id') for m in sent if m['role'] == 'tool'] == ['call-a', 'call-b']


def test_litellm_ollama_chat_still_drops_assistant_call_ids():
    """Pins the transport defect the adjustment exists for.

    If LiteLLM starts forwarding the assistant call id, this fails, and the ids
    should be kept on both sides instead of removed from the results.
    """
    body = OllamaChatConfig().transform_request('ollama_chat/m', _history(), {}, {}, {})
    assistant = next(m for m in body['messages'] if m['role'] == 'assistant')
    assert all('id' not in call for call in assistant['tool_calls'])
    assert match_tool_result_ids_to_route('ollama_chat/m', []) == []
