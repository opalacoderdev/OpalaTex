"""Tests for the MemGPT runtime (skills-oriented architecture, docs/specs/02, 06).

Verifies assembly and wiring WITHOUT invoking any LLM:
  - resolve_skill_model maps default/worker/explicit/absent correctly
  - build_chat_orchestrator produces a framework MemGPTAgentBlock with run_skill
    and the memory tools, and embeds Level-1 skill metadata in the system prompt
  - the intercepted send_message records into the MemGPT internal history
  - run_skill returns an error for an unknown skill (no LLM needed)
"""

import asyncio
import os


from opalatex.memgpt_runtime import (
    resolve_skill_model,
    build_chat_orchestrator,
    build_run_skill_tool,
    make_intercepted_send_message,
    _current_date_instruction,
)
from opalatex.project import ProjectData
from opalatex.config import DEFAULT_MODEL, WORKER_MODEL


def _project(tmp_path):
    return ProjectData(
        name="t", project_name="t",
        project_path=str(tmp_path), model="ollama/proj-model",
    )


def test_resolve_skill_model():
    # "default" → the project's main model (falls back to DEFAULT_MODEL when unset).
    assert resolve_skill_model({"model": "default"}, "ollama/x") == "ollama/x"
    assert resolve_skill_model({"model": "default"}, None) == DEFAULT_MODEL
    # "worker" → the project's worker model, else the main project model.
    assert resolve_skill_model({"model": "worker"}, "ollama/x") == "ollama/x"
    assert resolve_skill_model({"model": "worker"}, "ollama/x", "gemini/proj-worker") == "gemini/proj-worker"
    # "alternative" is also supported for backwards compatibility.
    assert resolve_skill_model({"model": "alternative"}, "ollama/x", "gemini/proj-worker") == "gemini/proj-worker"
    # Explicit id used as-is; absent → project model.
    assert resolve_skill_model({"model": "ollama/custom"}, "ollama/x") == "ollama/custom"
    assert resolve_skill_model({"model": ""}, "ollama/proj") == "ollama/proj"
    assert resolve_skill_model({}, None) == DEFAULT_MODEL


def test_build_chat_orchestrator_has_run_skill_and_memory_tools(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}
    assert "run_skill" in names
    assert {"read_core_memory", "append_core_memory", "search_conversation_history"} <= names


def test_chat_orchestrator_exposes_document_creation_tools(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}
    assert {"create_docx_file", "create_pptx_file"} <= names
    assert "You can use `create_docx_file`" in m.system_prompt
    assert "You can use `create_pptx_file`" in m.system_prompt


def test_chat_orchestrator_system_prompt_embeds_skill_metadata(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    # Bundled skills must surface as Level-1 metadata for routing.
    assert "Available skills" in m.system_prompt
    assert "view-editor" in m.system_prompt


def test_current_date_instruction_is_prepended_to_system_prompt(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    assert m.system_prompt.startswith("Today is ")
    assert "you MUST use the web_search tool before answering" in m.system_prompt
    assert "Never claim that a current, recent, or future-dated event did not happen" in m.system_prompt
    assert "send_message` with `message=\"\"`" in m.system_prompt


def test_current_date_instruction_formats_english_date():
    from datetime import datetime

    instruction = _current_date_instruction(datetime(2026, 7, 9))
    assert instruction.startswith("Today is July 9, 2026.")
    assert "web_search" in instruction


def test_uses_framework_memgpt_block(tmp_path):
    from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
    m = build_chat_orchestrator(_project(tmp_path), None)
    assert isinstance(m, MemGPTAgentBlock)


def test_intercepted_send_message_records_into_memgpt(tmp_path):
    from opalatex.agent_stdin import clear_worker_message_buffer, _worker_summary_response
    import opalatex.agent_stdin as stdin_mod

    clear_worker_message_buffer()
    events = []
    m = build_chat_orchestrator(_project(tmp_path), None)
    before = len(m.internal_history)
    sm = make_intercepted_send_message(m, "implement-feature")
    # FunctionBlock wraps the function; call the underlying callable.
    raw = getattr(sm, "_func", None) or sm
    m._current_worker_messages = []
    original_hook = stdin_mod.event_hook
    stdin_mod.event_hook = lambda payload: events.append(payload)
    try:
        result = raw("Created hello.txt with the requested content.")
    finally:
        stdin_mod.event_hook = original_hook
    assert "DONE" in result
    assert len(m.internal_history) == before
    assert m._current_worker_messages == ["Created hello.txt with the requested content."]
    assert _worker_summary_response(m) == "Created hello.txt with the requested content."
    assert {
        "event": "info",
        "message": "[implement-feature] Created hello.txt with the requested content.",
    } in events
    clear_worker_message_buffer()


def test_run_skill_unknown_skill_returns_error(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    run_skill = build_run_skill_tool(m, str(tmp_path), "ollama/proj")
    raw = getattr(run_skill, "_func", None) or run_skill
    result = asyncio.run(raw("does-not-exist", "context"))
    assert "[ERROR]" in result
    assert "not found" in result



def test_build_chat_orchestrator_scopes_project_path(tmp_path):
    """Regression: building the MemGPT must set the global project context so the
    sub-agent's file tools act inside the project, not the OpalaTex repo root."""
    from opalatex.tools import get_project_path
    build_chat_orchestrator(_project(tmp_path), None)
    assert os.path.abspath(get_project_path()) == os.path.abspath(str(tmp_path))
