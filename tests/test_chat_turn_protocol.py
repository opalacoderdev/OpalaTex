"""Tests for chat turn structure.

Covers the invariants a chat turn must satisfy end to end:
1. Corrective system alerts never split an assistant tool_calls message from its
   tool results (OpenAI adjacency requirement).
2. Context eviction never drops the user turn currently being answered.
3. Runtime corrections enter the history as system feedback, not as the user.
4. Persisted history seeds only the visible conversation, verbatim.
5. The orchestrator's working memory survives the per-turn rebuild.
"""

import asyncio
import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
from opalatex.memgpt_runtime import (
    restore_chat_orchestrator_state,
    save_chat_orchestrator_state,
    seed_chat_orchestrator_history,
)
from opalatex.project import ProjectData, ProjectStore


def _tool_call(call_id, name, arguments="{}"):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _response(content="", tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


# ---------------------------------------------------------------------------
# 1. Tool-block adjacency
# ---------------------------------------------------------------------------

def test_empty_send_message_alert_is_flushed_after_the_tool_block():
    """An empty send_message in a batch must not push its alert between results."""
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model", max_heartbeats=1)

    responses = [
        _response(tool_calls=[
            _tool_call("c1", "send_message", json.dumps({"message": ""})),
            _tool_call("c2", "send_message", json.dumps({"message": "done"})),
        ]),
        _response(content="final answer"),
    ]

    async def fake_acompletion(_messages, **_kwargs):
        return responses.pop(0)

    agent._acompletion = fake_acompletion
    asyncio.run(agent.run(AgentInput(prompt="do it")))

    roles = [m["role"] for m in agent.internal_history]
    assistant_index = roles.index("assistant")
    # Every tool result of the batch comes before any system alert.
    following = roles[assistant_index + 1:]
    tool_positions = [i for i, role in enumerate(following) if role == "tool"]
    system_positions = [i for i, role in enumerate(following) if role == "system"]
    assert tool_positions, "the tool results must be recorded"
    assert system_positions, "the empty send_message must still raise an alert"
    assert max(tool_positions) < min(system_positions)


# ---------------------------------------------------------------------------
# 2. Eviction
# ---------------------------------------------------------------------------

def test_eviction_never_drops_the_current_user_turn():
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    history = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "the question being answered right now"},
    ]

    # Even when asked to evict everything, the current turn survives.
    index = agent._get_safe_eviction_index(history, len(history))
    assert index <= 2
    assert history[index:][-1]["content"] == "the question being answered right now"


def test_eviction_index_is_zero_when_only_the_current_turn_exists():
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    history = [{"role": "user", "content": "only turn"}]

    assert agent._get_safe_eviction_index(history, 1) == 0


def test_eviction_keeps_user_turn_after_an_orphan_tool_call():
    """An interrupted run can leave an assistant tool call right before the turn."""
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    history = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
        {"role": "user", "content": "current turn"},
    ]

    index = agent._get_safe_eviction_index(history, 1)

    assert history[index:] == [{"role": "user", "content": "current turn"}]


# ---------------------------------------------------------------------------
# 3. Runtime correction role
# ---------------------------------------------------------------------------

def test_memgpt_accepts_a_system_role_prompt_for_runtime_corrections():
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model", max_heartbeats=1)

    async def fake_acompletion(_messages, **_kwargs):
        return _response(content="recovered answer")

    agent._acompletion = fake_acompletion
    asyncio.run(agent.run(AgentInput(prompt="SYSTEM ALERT: say something", role="system")))

    assert agent.internal_history[0] == {
        "role": "system",
        "content": "SYSTEM ALERT: say something",
    }


def test_memgpt_rejects_an_unknown_input_role():
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")

    with pytest.raises(ValueError):
        asyncio.run(agent.run(AgentInput(prompt="hi", role="assistant")))


def test_worker_agent_rejects_a_non_user_role():
    """A block without a conversation history has nowhere to put system feedback."""
    agent = LLMAgentBlock(name="worker", model="fake/model")

    with pytest.raises(ValueError):
        asyncio.run(agent.run(AgentInput(prompt="hi", role="system")))


# ---------------------------------------------------------------------------
# 4. Seeding from persisted history
# ---------------------------------------------------------------------------

def test_seeding_replays_only_the_visible_conversation_verbatim():
    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    project = SimpleNamespace(history=[
        {"role": "system", "content": "[MODE] Agent turn started.", "timestamp": "2026-08-15T10:00:00"},
        {"role": "user", "content": "hello", "timestamp": "2026-08-15T10:00:01"},
        {"role": "tool", "content": "tool output", "timestamp": "2026-08-15T10:00:02"},
        {"role": "assistant", "content": "hi there", "timestamp": "2026-08-15T10:00:03"},
        {"role": "assistant", "content": "Agent Error: boom", "timestamp": "2026-08-15T10:00:04"},
    ])

    seed_chat_orchestrator_history(agent, project)

    assert agent.internal_history == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
    ]


# ---------------------------------------------------------------------------
# 5. Working-memory persistence across the per-turn rebuild
# ---------------------------------------------------------------------------

def test_orchestrator_state_survives_a_rebuild(tmp_path):
    store = ProjectStore(db_path=str(tmp_path / "projects.db"))
    store.create(
        name="proj",
        mode="auto",
        model="fake/model",
        project_name="Proj",
        project_path=str(tmp_path),
    )
    project = store.load("proj")

    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    agent.internal_history = [
        {"role": "user", "content": "remember the number 7"},
        {"role": "assistant", "content": "noted"},
    ]
    agent.recursive_summary = "The user shared a number."
    save_chat_orchestrator_state(agent, project, store)

    rebuilt = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    assert restore_chat_orchestrator_state(rebuilt, project, store) is True
    assert rebuilt.internal_history == agent.internal_history
    assert rebuilt.recursive_summary == "The user shared a number."


def test_orchestrator_state_is_dropped_when_the_chat_is_cleared(tmp_path):
    store = ProjectStore(db_path=str(tmp_path / "projects.db"))
    store.create(
        name="proj",
        mode="auto",
        model="fake/model",
        project_name="Proj",
        project_path=str(tmp_path),
    )
    project = store.load("proj")

    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    agent.internal_history = [{"role": "user", "content": "forget me"}]
    save_chat_orchestrator_state(agent, project, store)

    store.clear_project_history("proj", project.current_chat_id)

    rebuilt = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    assert restore_chat_orchestrator_state(rebuilt, project, store) is False
    assert rebuilt.internal_history == []


def test_orchestrator_state_is_dropped_when_a_message_is_superseded(tmp_path):
    store = ProjectStore(db_path=str(tmp_path / "projects.db"))
    store.create(
        name="proj",
        mode="auto",
        model="fake/model",
        project_name="Proj",
        project_path=str(tmp_path),
    )
    project = store.load("proj")
    anchor_id = store.append_message(project, "user", "original question")
    store.append_message(project, "assistant", "original answer")

    agent = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    agent.internal_history = [
        {"role": "user", "content": "original question"},
        {"role": "assistant", "content": "original answer"},
    ]
    save_chat_orchestrator_state(agent, project, store)

    store.supersede_chat_history_from_message("proj", project.current_chat_id, message_id=anchor_id)

    rebuilt = MemGPTAgentBlock(name="chat_orchestrator", model="fake/model")
    assert restore_chat_orchestrator_state(rebuilt, project, store) is False
