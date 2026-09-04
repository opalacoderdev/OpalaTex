"""The model decides when its turn ends, as in classic MemGPT.

The reported failure: in plan mode the orchestrator ended its turn saying it was
*about to* act -- "I will now read the file and draft the plan" -- and nothing
happened. It was not a hallucination about continuing. `MemGPTAgentBlock` ended
the run on any response carrying visible text and no tool call, so the model was
cut off mid-thought and its announcement delivered as the final answer; from its
own side it *was* continuing. The `request_heartbeat` decision point of the
MemGPT design existed but was reachable only through `send_message`, a tool whose
description told the model to prefer plain text instead.

Under `model_controlled_turn_end` plain text is narration: the run continues so
the model can take the step it announced, and the turn ends when the model ends
it. `max_heartbeats` becomes a runaway guardrail rather than a budget, and
`max_narration_steps` bounds a model that never acts at all.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from agenticblocks.blocks.llm.agent import AgentInput
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from agenticblocks.core.function_block import as_tool


def _tool_call(call_id, name, arguments):
    return SimpleNamespace(
        id=call_id, type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _response(tool_calls=None, content=""):
    message = SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _reasoning(text):
    """A response that is all reasoning channel and no visible content."""
    message = SimpleNamespace(content="", tool_calls=None, reasoning_content=text)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _finish(text, call_id="f1"):
    """The explicit turn end: send_message with request_heartbeat=false."""
    return _response(tool_calls=[_tool_call(
        call_id, "send_message", json.dumps({"message": text, "request_heartbeat": False})
    )])


def _build(reads, **kwargs):
    @as_tool(name="read_file", description="Read a file.")
    def read_file(path: str) -> str:
        reads.append(path)
        return "file contents"

    return MemGPTAgentBlock(
        name="orchestrator", system_prompt="s", tools=[read_file],
        max_heartbeats=kwargs.pop("max_heartbeats", 30), **kwargs,
    )


def _script(agent, responses):
    """Drive the loop with a fixed sequence of provider responses."""
    calls = {"n": 0, "tool_choice": []}

    async def fake_acompletion(messages, **kw):
        calls["tool_choice"].append(kw.get("tool_choice"))
        idx = calls["n"]
        calls["n"] += 1
        return responses[min(idx, len(responses) - 1)]

    agent._acompletion = fake_acompletion
    return calls


def _run(agent, prompt="do the thing"):
    return asyncio.run(agent.run(AgentInput(prompt=prompt)))


# ── The failure that started this ────────────────────────────────────────────

def test_the_announcement_no_longer_ends_the_turn():
    """The exact reported trace: narrate, then actually act, then finish."""
    reads = []
    agent = _build(reads, model_controlled_turn_end=True)
    calls = _script(agent, [
        _response(content="I will now read main.tex and draft the plan."),
        _response(tool_calls=[_tool_call("c1", "read_file", '{"path": "main.tex"}')]),
        _finish("Here is the plan: 1. ... 2. ..."),
    ])

    out = _run(agent)

    assert reads == ["main.tex"], "the announced action actually ran"
    assert out.response == "Here is the plan: 1. ... 2. ..."
    assert calls["n"] == 3
    assert out.termination_reason == "send_message called with request_heartbeat=false"


def test_the_same_trace_is_cut_short_under_the_old_default():
    """Regression guard for every existing caller: the default is unchanged."""
    reads = []
    agent = _build(reads)  # model_controlled_turn_end defaults to False
    _script(agent, [
        _response(content="I will now read main.tex and draft the plan."),
        _response(tool_calls=[_tool_call("c1", "read_file", '{"path": "main.tex"}')]),
        _finish("Here is the plan."),
    ])

    out = _run(agent)

    assert reads == [], "nothing ran: the announcement was taken as the answer"
    assert out.response == "I will now read main.tex and draft the plan."
    assert out.termination_reason == "model returned a final text response (no tool calls)"


def test_the_model_is_told_its_narration_was_not_the_end():
    reads = []
    agent = _build(reads, model_controlled_turn_end=True)
    _script(agent, [
        _response(content="Let me check the file first."),
        _finish("Done."),
    ])

    _run(agent)

    alerts = [
        m for m in agent.internal_history
        if m.get("role") == "system" and "arrived as plain text" in str(m.get("content", ""))
    ]
    assert len(alerts) == 1
    # The narration itself stays in the history: it is what the model said, and
    # dropping it would leave the model reading a hole where its own reasoning was.
    assert any(
        m.get("role") == "assistant" and m.get("content") == "Let me check the file first."
        for m in agent.internal_history
    )


# ── The bounded fallback ─────────────────────────────────────────────────────

def test_the_announcement_is_never_promoted_to_the_answer():
    """The fallback must not deliver the very failure it exists to stop.

    Accepting the last narration as the final response hands the user "I will now
    read the file" as the answer -- an announcement of work nobody did, which is
    exactly the reported bug. Once the allowance is spent the answer is asked for
    explicitly instead, with tool calls off the table so the request cannot be
    answered with yet another intention.
    """
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=2, max_heartbeats=30)
    seen = {"forced": 0}

    async def fake(messages, **kw):
        seen.setdefault("tool_choice", []).append(kw.get("tool_choice"))
        last = messages[-1]
        if last.get("role") == "system" and "Do NOT state what you are going to do" in str(last.get("content")):
            seen["forced"] += 1
            return _response(content="I could not open the file: no tool ran. Give me its path.")
        return _response(content="I will now read the file and draft the plan.")

    agent._acompletion = fake
    out = _run(agent)

    assert seen["tool_choice"] == ["auto", "auto", "none"], "the last request forbids tool calls"
    assert seen["forced"] == 1
    assert out.response == "I could not open the file: no tool ran. Give me its path."
    assert "2 narration steps" in out.termination_reason


def test_the_forced_answer_costs_one_call_not_the_guardrail():
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=2, max_heartbeats=30)
    calls = _script(agent, [_response(content="Working on it...")])

    _run(agent)

    assert calls["n"] == 3, "two narration steps, then the forced final answer"


# ── Reasoning-only responses are the same failure ────────────────────────────

def test_reasoning_only_responses_share_the_narration_allowance():
    """The observed trace: 24 calls repeating one thought, then an announcement.

    A response that is all reasoning and no action is a model that did not act,
    exactly like narration, but it used to be bounded only by the whole heartbeat
    guardrail -- and the branch that handles it drops the message, so the model
    never reads its own attempt back and writes the same thought again.
    """
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=2, max_heartbeats=30)
    calls = _script(agent, [_reasoning("I should call get_editor_state first.")] * 40)

    out = _run(agent)

    assert calls["n"] == 3, "three calls, not the 27 the reported trace burned"
    assert out.response == "", "no answer is honest; an announcement would not be"
    assert "only reasoning" in out.termination_reason


def test_a_model_that_reasons_then_answers_when_asked_still_answers():
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=2, max_heartbeats=30)

    async def fake(messages, **kw):
        if kw.get("tool_choice") == "none":
            return _response(content="I could not act; here is what I know.")
        return _reasoning("thinking...")

    agent._acompletion = fake
    out = _run(agent)

    assert out.response == "I could not act; here is what I know."


def test_acting_resets_the_narration_run():
    """Narrate, act, narrate, act is normal work, not a model going in circles."""
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=2)
    _script(agent, [
        _response(content="First I will read the file."),
        _response(tool_calls=[_tool_call("c1", "read_file", '{"path": "a.tex"}')]),
        _response(content="Now I will read the second one."),
        _response(tool_calls=[_tool_call("c2", "read_file", '{"path": "b.tex"}')]),
        _finish("Both files read."),
    ])

    out = _run(agent)

    assert reads == ["a.tex", "b.tex"], "the run was never cut by the narration cap"
    assert out.response == "Both files read."


def test_the_guardrail_still_ends_the_run():
    """A narration loop cannot outlive max_heartbeats.

    With the budget spent the request already forbids tool calls, so there is no
    next step to wait for and the text has to be accepted.
    """
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=99, max_heartbeats=3)
    calls = _script(agent, [_response(content="thinking out loud")])

    out = _run(agent)

    assert calls["n"] <= 5, "the guardrail bounds the run"
    assert calls["tool_choice"][-1] == "none", "the last request forbade tool calls"
    assert out.response == "thinking out loud"
    assert "heartbeat guardrail was spent" in out.termination_reason


def test_narration_consumes_the_guardrail_like_any_other_step():
    reads = []
    agent = _build(reads, model_controlled_turn_end=True, max_narration_steps=99, max_heartbeats=2)
    calls = _script(agent, [_response(content="narrating")])

    _run(agent)

    # Two narration steps, then the forced final request: a narration step costs
    # exactly what a tool-call step costs, so the guardrail means what it says.
    assert calls["n"] == 3


# ── The rules the model reads ────────────────────────────────────────────────

def test_the_prompt_stops_teaching_that_plain_text_ends_the_turn():
    """The old rules did not merely fail to help; they instructed the failure."""
    on = _build([], model_controlled_turn_end=True)._build_system_prompt()
    off = _build([])._build_system_prompt()

    assert "does NOT end your" in on
    assert "request_heartbeat=false" in on
    assert "You decide when the turn ends" in on
    assert "return the final answer as normal text" not in on

    # Unchanged for every caller that did not opt in.
    assert "return the final answer as normal text" in off
    assert "does NOT end your" not in off


def test_send_message_stops_describing_itself_as_legacy():
    """The one place the model could end a turn deliberately told it not to."""
    agent = _build([], model_controlled_turn_end=True)
    schemas = {}

    async def capture(messages, **kw):
        for tool in kw.get("tools", []):
            schemas[tool["function"]["name"]] = tool["function"]["description"]
        return _finish("done")

    agent._acompletion = capture
    _run(agent)

    assert "End your turn" in schemas["send_message"]
    assert "Legacy" not in schemas["send_message"]


# ── The OpalaTex wiring ──────────────────────────────────────────────────────

def test_the_chat_orchestrator_runs_with_the_model_in_control(tmp_path):
    from opalatex.memgpt_runtime import build_chat_orchestrator
    from opalatex.project import ProjectData

    agent = build_chat_orchestrator(ProjectData(
        name="t", project_name="t", project_path=str(tmp_path),
        model="ollama/gemma4:12b", mode="plan",
    ), None)

    assert agent.model_controlled_turn_end is True
    assert agent.max_narration_steps == 2
    assert agent.max_heartbeats == 30, "a guardrail, not the old budget"


def test_a_project_can_turn_it_off_and_retune_it(tmp_path):
    from opalatex.memgpt_runtime import build_chat_orchestrator
    from opalatex.project import ProjectData

    agent = build_chat_orchestrator(ProjectData(
        name="t", project_name="t", project_path=str(tmp_path),
        model="ollama/gemma4:12b", mode="plan",
        model_params={"model_controlled_turn_end": False, "max_narration_steps": 5},
    ), None)

    assert agent.model_controlled_turn_end is False
    assert agent.max_narration_steps == 5


@pytest.mark.parametrize("params,expected", [
    ({"model_controlled_turn_end": False}, {"model_controlled_turn_end": False}),
    ({"max_narration_steps": "4"}, {"max_narration_steps": 4}),
    ({"max_narration_steps": 99}, {"max_narration_steps": 10}),   # clamped
])
def test_the_settings_survive_a_project_save(params, expected):
    """Absent from the schema they would be silently dropped on save."""
    from opalatex.config import sanitize_model_params

    assert sanitize_model_params(params) == expected


def test_the_settings_never_reach_the_provider():
    """They are agent constructor params, not LiteLLM request parameters."""
    from opalatex.config import _NON_LITELLM_FIELDS, _AGENT_PARAM_KEYS

    assert {"model_controlled_turn_end", "max_narration_steps"} <= _NON_LITELLM_FIELDS
    assert {"model_controlled_turn_end", "max_narration_steps"} <= _AGENT_PARAM_KEYS
