"""A model call that has gone quiet is reported, and nothing else changes.

Observed in a real session: a pooled connection to the Ollama cloud died while a
request was being sent. The client cannot tell that from a model that is still
thinking, so the turn sat on its 600 s HTTP timeout with nothing on screen, then
LiteLLM's Router retried on a fresh connection and the answer arrived in about a
second. `on_response_wait` gives the host a signal during that silence. It must
only observe: the request, its result and its errors are exactly as before.
"""
import asyncio
from types import SimpleNamespace

import litellm
import pytest

from agenticblocks.blocks.llm.agent import LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from agenticblocks.blocks.llm.response_wait import ResponseWaitWatch

NOTICE_AFTER = 0.05


def _message():
    message = SimpleNamespace(content="done", tool_calls=None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _chunk(text):
    delta = SimpleNamespace(content=text, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _agent(block_cls, waits, **extra):
    agent = block_cls(
        name="probe", system_prompt="s", tools=[], model="ollama_chat/probe:cloud",
        use_shared_router=False, response_wait_notice_after=NOTICE_AFTER, **extra,
    )
    agent.on_response_wait = waits.append
    return agent


BLOCKS = pytest.mark.parametrize("block_cls", [LLMAgentBlock, MemGPTAgentBlock])


@BLOCKS
def test_a_silent_call_is_reported_and_then_closed(monkeypatch, block_cls):
    async def slow_acompletion(**_kwargs):
        await asyncio.sleep(NOTICE_AFTER * 4)
        return _message()

    monkeypatch.setattr(litellm, "acompletion", slow_acompletion)
    waits = []
    response = asyncio.run(_agent(block_cls, waits)._acompletion([{"role": "user", "content": "q"}]))

    assert response.choices[0].message.content == "done"
    assert [(w.waiting, w.phase) for w in waits] == [
        (True, "first_response"),
        (False, "first_response"),
    ]
    assert waits[0].elapsed_seconds >= NOTICE_AFTER
    assert waits[0].agent == "probe" and waits[0].model == "ollama_chat/probe:cloud"


@BLOCKS
def test_a_stream_that_stalls_is_reported_when_it_stops_and_when_it_resumes(monkeypatch, block_cls):
    async def stream():
        yield _chunk("a")
        await asyncio.sleep(NOTICE_AFTER * 4)
        yield _chunk("b")

    async def fake_acompletion(**_kwargs):
        return stream()

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    monkeypatch.setattr(litellm, "stream_chunk_builder", lambda chunks, messages=None: chunks)
    waits, visible = [], []
    agent = _agent(block_cls, waits)
    agent.on_chunk = visible.append

    asyncio.run(agent._acompletion([{"role": "user", "content": "q"}], stream=True))

    assert visible == ["a", "b"], "the stream itself is untouched"
    assert [(w.waiting, w.phase) for w in waits] == [(True, "stream"), (False, "stream")]
    assert waits[1].elapsed_seconds >= NOTICE_AFTER


@BLOCKS
def test_a_prompt_call_reports_nothing(monkeypatch, block_cls):
    async def fast_acompletion(**_kwargs):
        return _message()

    monkeypatch.setattr(litellm, "acompletion", fast_acompletion)
    waits = []
    asyncio.run(_agent(block_cls, waits)._acompletion([{"role": "user", "content": "q"}]))

    assert waits == []


@BLOCKS
def test_a_call_that_fails_after_the_notice_still_closes_it_and_raises(monkeypatch, block_cls):
    async def failing_acompletion(**_kwargs):
        await asyncio.sleep(NOTICE_AFTER * 4)
        raise litellm.Timeout("timed out", model="probe", llm_provider="ollama_chat")

    monkeypatch.setattr(litellm, "acompletion", failing_acompletion)
    waits = []
    with pytest.raises(litellm.Timeout):
        asyncio.run(_agent(block_cls, waits)._acompletion([{"role": "user", "content": "q"}]))

    assert [w.waiting for w in waits] == [True, False]


@BLOCKS
def test_a_failing_callback_does_not_break_the_call(monkeypatch, block_cls):
    async def slow_acompletion(**_kwargs):
        await asyncio.sleep(NOTICE_AFTER * 4)
        return _message()

    def broken(_wait):
        raise RuntimeError("host bug")

    monkeypatch.setattr(litellm, "acompletion", slow_acompletion)
    agent = _agent(block_cls, [])
    agent.on_response_wait = broken

    response = asyncio.run(agent._acompletion([{"role": "user", "content": "q"}]))
    assert response.choices[0].message.content == "done"


@BLOCKS
def test_cancelling_the_call_leaves_no_watch_running(monkeypatch, block_cls):
    async def hanging_acompletion(**_kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(litellm, "acompletion", hanging_acompletion)
    waits = []

    async def scenario():
        call = asyncio.create_task(
            _agent(block_cls, waits)._acompletion([{"role": "user", "content": "q"}])
        )
        await asyncio.sleep(NOTICE_AFTER * 3)
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        await asyncio.sleep(0)
        return [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    leftover = asyncio.run(scenario())

    assert leftover == []
    assert [w.waiting for w in waits] == [True, False]


def test_without_a_callback_no_watch_is_started():
    async def scenario():
        watch = ResponseWaitWatch(None, agent="a", model="m", notice_after=NOTICE_AFTER).start()
        return watch._task

    assert asyncio.run(scenario()) is None


def test_a_disabled_threshold_starts_no_watch():
    async def scenario():
        watch = ResponseWaitWatch(lambda _w: None, agent="a", model="m", notice_after=None).start()
        return watch._task

    assert asyncio.run(scenario()) is None
