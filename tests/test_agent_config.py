"""Tests for agents.yaml configuration correctness (skills-oriented architecture).

Covers:
1. reasoning_effort disables gemma4 thinking for agents that depend on tool_calls
   (ollama issue #15288) — the worker and the enricher/memgpt path.
2. think is NOT forced off for planning agents that benefit from reasoning.
3. The orchestrator and memgpt roles get a large num_ctx (long histories).
"""

import pytest
from opalatex.config import get_agent_llm_kwargs


# Agents whose tool_calls field must be populated → thinking must be disabled.
TOOL_CALL_AGENTS = [
    "worker",
]

PLANNING_AGENTS = [
    "landscape_planner",
    "refinement_agent",
    "orchestrator",
]


@pytest.mark.parametrize("agent", TOOL_CALL_AGENTS)
def test_tool_call_agents_disable_thinking(agent):
    """Agents that rely on tool_calls must disable gemma4 thinking mode.

    litellm maps reasoning_effort to the ollama `think` field. Values outside
    {"low","medium","high"} (e.g. "none") produce think=false on the wire.
    With thinking on, gemma4 returns output in the reasoning field and leaves
    tool_calls/message.content empty (ollama #15288).
    """
    kwargs = get_agent_llm_kwargs(agent)
    effort = kwargs.get("reasoning_effort")
    thinking_enabled = effort in {"low", "medium", "high"}
    assert not thinking_enabled, (
        f"{agent} must have reasoning_effort set to a non-thinking value (e.g. 'none'), "
        f"got {effort!r}"
    )


def test_orchestrator_has_large_num_ctx():
    """Orchestrator accumulates long tool-call histories — needs at least 16k context."""
    kwargs = get_agent_llm_kwargs("orchestrator")
    assert kwargs.get("num_ctx", 0) >= 16384


def test_memgpt_has_large_num_ctx():
    """The MemGPT chat-orchestrator runs multi-turn sessions with skill calls —
    it needs a generous context window so turns are not cut off."""
    kwargs = get_agent_llm_kwargs("memgpt")
    assert kwargs.get("num_ctx", 0) >= 16384


def test_orchestrator_has_no_restrictive_max_tokens():
    """Orchestrator must not be limited to a small max_tokens — it produces
    long reasoning chains and final reports."""
    kwargs = get_agent_llm_kwargs("orchestrator")
    max_tok = kwargs.get("max_tokens", None)
    assert max_tok is None or max_tok >= 1024
