"""A multimodal request keeps the model's own route.

`_acompletion` used to rewrite `ollama_chat/<model>` to `ollama/<model>` whenever
the request carried an image, because Ollama's native `/api/chat` did not accept
OpenAI-style `image_url` parts while the OpenAI-compatible route did.

That reroute became the more expensive bug. On the `ollama/` route a streamed
tool call never arrives as `tool_calls`: the provider emits it as plain text, one
token at a time (`{"`, `name`, `":"`, ...), so there is nothing for
`stream_chunk_builder` to assemble and the model's action reaches the caller as
prose. Measured against `ollama_chat/kimi-k3:cloud`: 93 chunks, zero carrying
`delta.tool_calls`, the whole call rebuilt as the string
`{"name":"get_editor_state","arguments":{}}`. An agent that attached an image
lost its ability to act for the entire turn -- it could only announce what it
would have done, which is what the user saw.

LiteLLM converts image parts for the native route now, so the reroute buys
nothing. This is the guard against reintroducing it.
"""
import asyncio
from types import SimpleNamespace

import pytest

import litellm

from agenticblocks.blocks.llm.agent import AgentInput
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock


IMAGE = {"type": "image", "mime": "image/png", "data": "AAA", "name": "s.png"}


def _canned(_content="done"):
    message = SimpleNamespace(content=_content, tool_calls=None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _agent(model):
    return MemGPTAgentBlock(
        name="p", system_prompt="s", tools=[], model=model,
        max_heartbeats=1, use_shared_router=False,
    )


def _run_capturing_route(monkeypatch, model, attachments):
    seen = {}

    async def fake_acompletion(**kwargs):
        seen["model"] = kwargs.get("model")
        seen["content"] = kwargs["messages"][-1].get("content")
        return _canned()

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    asyncio.run(_agent(model).run(AgentInput(prompt="look", attachments=attachments)))
    return seen


@pytest.mark.parametrize("model", [
    "ollama_chat/kimi-k3:cloud",
    "ollama_chat/gemma4:12b",
])
def test_an_image_does_not_move_the_request_off_the_native_route(monkeypatch, model):
    seen = _run_capturing_route(monkeypatch, model, [IMAGE])

    assert seen["model"] == model, "the reroute to ollama/ costs the turn its tool calls"
    # The image really is in the request: the route is kept *with* the picture,
    # not by dropping it.
    parts = seen["content"]
    assert isinstance(parts, list)
    assert any(p.get("type") == "image_url" for p in parts)


def test_a_request_without_images_is_unaffected(monkeypatch):
    seen = _run_capturing_route(monkeypatch, "ollama_chat/kimi-k3:cloud", [])

    assert seen["model"] == "ollama_chat/kimi-k3:cloud"
    assert seen["content"] == "look"


@pytest.mark.parametrize("model", ["gemini/gemini-3.7-flash", "openai/gpt-4o"])
def test_other_providers_keep_their_route_with_images(monkeypatch, model):
    """The rewrite only ever targeted ollama_chat; nothing else may acquire one."""
    seen = _run_capturing_route(monkeypatch, model, [IMAGE])

    assert seen["model"] == model
