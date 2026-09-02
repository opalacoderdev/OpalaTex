"""Reasoning written into the content channel must never reach the chat.

A thinking-capable model whose project has thinking turned off still reasons.
With the provider's reasoning channel unused, that reasoning arrives inline in
`delta.content`, and — because the chat template already seeded the opening
`<think>` in the prompt — it is terminated by an orphan `</think>` with no
opening tag. Every splitter used to require a balanced pair, so the whole
reasoning prefix was published as if it were the answer.
"""

import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agenticblocks.blocks.llm.agent import AgentInput
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from agenticblocks.utils.parsers import (
    split_inline_reasoning,
    split_inline_reasoning_parts,
)
from opalatex.agent_stdin import _sanitize_model_response, _visible_chat_response
from opalatex.think_stream import InlineReasoningStreamSplitter


LEAKED = (
    "Cleanup done. Now the final answer in Portuguese. Let me structure it clearly:\n"
    "</think>Analisei os slides 4-9."
)


# ── parser ────────────────────────────────────────────────────────────────────

def test_orphan_closing_tag_marks_everything_before_it_as_reasoning():
    reasoning, visible = split_inline_reasoning(LEAKED)
    assert visible == "Analisei os slides 4-9."
    assert reasoning.startswith("Cleanup done.")


def test_balanced_blocks_are_still_collected_in_order():
    parts, visible = split_inline_reasoning_parts(
        "<think>first</think>Visible answer.<think>second</think>"
    )
    assert visible == "Visible answer."
    assert parts == ["first", "second"]


def test_closing_tag_after_an_opening_one_is_ordinary_text():
    parts, visible = split_inline_reasoning_parts(
        "<think>note</think>The </think> tag closes a reasoning block."
    )
    assert parts == ["note"]
    assert visible == "The </think> tag closes a reasoning block."


def test_content_without_reasoning_is_untouched():
    assert split_inline_reasoning("Plain answer.") == ("", "Plain answer.")


# ── chat history / visible response ───────────────────────────────────────────

def test_sanitize_model_response_moves_orphan_reasoning_into_thoughts():
    thoughts = []
    visible = _sanitize_model_response(LEAKED, thoughts)
    assert visible == "Analisei os slides 4-9."
    assert len(thoughts) == 1
    assert thoughts[0].startswith("Cleanup done.")


def test_visible_chat_response_drops_orphan_reasoning():
    assert _visible_chat_response(LEAKED) == "Analisei os slides 4-9."


# ── streaming ─────────────────────────────────────────────────────────────────

class _Sink:
    """Consumer that models the UI: it applies retractions as they arrive."""

    def __init__(self):
        self.published = ""
        self.thinking = []
        self.retracted = []

    def splitter(self):
        return InlineReasoningStreamSplitter(
            on_visible=self._publish,
            on_thinking=self.thinking.append,
            on_retract=self._retract,
        )

    def _publish(self, text):
        self.published += text

    def _retract(self, text):
        self.retracted.append(text)
        self.published = (
            self.published[: -len(text)]
            if self.published.endswith(text)
            else ""
        )


def _feed(splitter, chunks):
    splitter.begin_response()
    for chunk in chunks:
        splitter.feed(chunk)
    splitter.flush()


def test_stream_retracts_reasoning_published_before_the_orphan_close():
    sink = _Sink()
    _feed(sink.splitter(), ["Cleanup done. ", "Let me struct", "ure it.\n</thi", "nk>Analisei."])

    assert sink.published == "Analisei."
    assert sink.retracted == ["Cleanup done. Let me structure it.\n"]
    assert "".join(sink.thinking) == "Cleanup done. Let me structure it.\n"


def test_stream_splits_balanced_blocks_across_chunk_boundaries():
    sink = _Sink()
    _feed(sink.splitter(), ["<thi", "nk>reasoning</th", "ink>Answer here."])

    assert sink.published == "Answer here."
    assert sink.retracted == []
    assert "".join(sink.thinking) == "reasoning"


def test_stream_holds_back_a_partial_tag_until_it_resolves():
    sink = _Sink()
    splitter = sink.splitter()
    splitter.begin_response()
    splitter.feed("Answer <th")
    assert sink.published == "Answer "  # the partial tag is not published yet
    splitter.feed("ink>hidden</think> done.")
    splitter.flush()

    assert sink.published == "Answer  done."
    assert "".join(sink.thinking) == "hidden"


def test_a_lone_angle_bracket_is_released_once_it_cannot_be_a_tag():
    sink = _Sink()
    splitter = sink.splitter()
    splitter.begin_response()
    splitter.feed("Answer <th")
    splitter.feed("at is fine.")
    splitter.flush()

    assert sink.published == "Answer <that is fine."
    assert sink.thinking == []


def test_stream_never_retracts_across_llm_responses():
    """An orphan close in one heartbeat must not take back an earlier answer."""
    sink = _Sink()
    splitter = sink.splitter()

    splitter.begin_response()
    splitter.feed("Partial answer from the first call. ")

    splitter.begin_response()
    splitter.feed("second call reasoning")
    splitter.feed("</think>Second answer.")
    splitter.flush()

    assert sink.retracted == ["second call reasoning"]
    assert sink.published == "Partial answer from the first call. Second answer."


def test_stream_leaves_a_plain_answer_alone():
    sink = _Sink()
    _feed(sink.splitter(), ["No tags ", "at all."])

    assert sink.published == "No tags at all."
    assert sink.thinking == []
    assert sink.retracted == []


# ── the MemGPT loop ───────────────────────────────────────────────────────────

def _scripted_response(content):
    message = SimpleNamespace(content=content, tool_calls=None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _agent(content):
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model", max_heartbeats=3)

    async def fake_acompletion(_messages, **_kwargs):
        return _scripted_response(content)

    agent._acompletion = fake_acompletion
    return agent


def test_memgpt_loop_answers_with_the_visible_half_only():
    agent = _agent(LEAKED)

    out = asyncio.run(agent.run(AgentInput(prompt="check the slides")))

    assert out.response == "Analisei os slides 4-9."


def test_memgpt_loop_files_orphan_reasoning_under_reasoning_content():
    """History must carry it as reasoning, which the next request strips out."""
    agent = _agent(LEAKED)

    asyncio.run(agent.run(AgentInput(prompt="check the slides")))

    assistant = [m for m in agent.internal_history if m.get("role") == "assistant"][-1]
    assert assistant["content"] == "Analisei os slides 4-9."
    assert assistant["reasoning_content"].startswith("Cleanup done.")


def test_a_dangling_partial_tag_is_released_at_the_response_boundary():
    """A tag cannot span two responses, so a held-back tail is not dropped."""
    sink = _Sink()
    splitter = sink.splitter()

    splitter.begin_response()
    splitter.feed("Answer ends with <")
    assert sink.published == "Answer ends with "

    splitter.begin_response()
    splitter.feed("Next answer.")
    splitter.flush()

    assert sink.published == "Answer ends with <Next answer."


# ── the wire flag is a parsing switch, not a display switch ───────────────────

def test_a_thinking_capable_model_is_always_asked_to_separate_the_channels():
    """Verified against ollama_chat/glm-5.3:cloud: with think=false the model still
    reasons and the reasoning lands in `content` *undelimited*, so it is published
    as the answer. Only think=true makes the provider isolate it."""
    from opalatex.config import resolve_think_request

    assert resolve_think_request(supports_thinking=True) is True


def test_a_model_without_thinking_support_never_receives_the_param():
    from opalatex.config import resolve_think_request

    assert resolve_think_request(supports_thinking=False) is None


def test_the_catalog_capability_is_the_only_input_to_the_think_decision():
    """No preference argument exists to be threaded in from a project setting.

    Thinking used to be storable per project as well, which left two switches
    disagreeing about one behaviour; the catalog capability is now the sole
    source of truth.
    """
    import inspect
    from opalatex.config import resolve_think_request

    assert list(inspect.signature(resolve_think_request).parameters) == [
        "supports_thinking"
    ]
