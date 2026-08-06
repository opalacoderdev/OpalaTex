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
    _recent_failed_skill_attempts,
    _sanitize_skill_result_for_prompt,
    _tool_calls_count,
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
    # Explicit id used as-is; absent → worker model, falling back to project model.
    assert resolve_skill_model({"model": "ollama/custom"}, "ollama/x") == "ollama/custom"
    assert resolve_skill_model({"model": ""}, "ollama/proj") == "ollama/proj"
    assert resolve_skill_model({}, "openrouter/qwen/qwen3.7-plus", "ollama/gemma4:26b") == "ollama/gemma4:26b"
    assert resolve_skill_model({}, None) == DEFAULT_MODEL


def test_build_chat_orchestrator_has_run_skill_and_memory_tools(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}
    assert "run_skill" in names
    assert {"read_core_memory", "append_core_memory", "search_conversation_history"} <= names


def test_chat_orchestrator_exposes_surgical_edit_tools(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}
    assert {"search_code", "read_content_pos", "replace_content_range", "write_content_pos"} <= names
    assert "replace_content_range" in m.system_prompt


def test_chat_orchestrator_exposes_search_code_for_targeted_search(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}

    assert "search_code" in names
    assert "Never guess high line numbers" in m.system_prompt
    assert "rg -n" not in m.system_prompt


def test_chat_orchestrator_exposes_document_creation_tools(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    names = {getattr(t, "name", None) for t in m.tools}
    assert {"create_docx_file", "create_pptx_file"} <= names
    assert "You can use `create_docx_file`" in m.system_prompt
    assert "You can use `create_pptx_file`" in m.system_prompt


def test_chat_orchestrator_context_limit_defaults_to_project_num_ctx(tmp_path):
    project = _project(tmp_path)
    project.model_params = {"num_ctx": 65536}
    m = build_chat_orchestrator(project, None)

    assert m.max_context_tokens == 65536


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
    assert "Text content is never a tool call" in m.system_prompt


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


def test_run_skill_returns_blocked_result_in_plan_mode(tmp_path):
    project = _project(tmp_path)
    project.mode = "plan"
    m = build_chat_orchestrator(project, None)
    run_skill = build_run_skill_tool(m, str(tmp_path), "ollama/proj", _project_ref=project)
    raw = getattr(run_skill, "_func", None) or run_skill

    result = asyncio.run(raw("command-line", "write a file"))

    assert result.startswith("[BLOCKED] run_skill is not available")
    assert "create_plan" in result


def test_run_skill_breaks_consecutive_failed_worker_loop(tmp_path):
    m = build_chat_orchestrator(_project(tmp_path), None)
    m._skill_run_history = [
        {
            "skill": "command-line",
            "context": "attempt 1",
            "result": "[AVISO: O worker terminou sem um resumo claro. Ele realizou 0 chamadas de ferramenta e o último texto gerado foi: ]",
        },
        {
            "skill": "command-line",
            "context": "attempt 2",
            "result": "[CRITICAL WORKER CRASH] A exceção não tratada interrompeu o worker: litellm.APIConnectionError",
        },
    ]
    run_skill = build_run_skill_tool(m, str(tmp_path), "ollama/proj")
    raw = getattr(run_skill, "_func", None) or run_skill

    result = asyncio.run(raw("command-line", "attempt 3"))

    assert "WORKER LOOP BREAKER" in result
    assert "Do NOT call this same worker again" in result
    assert _recent_failed_skill_attempts(m, "command-line") == 2


def test_sanitize_skill_result_for_prompt_removes_raw_tool_json():
    result = (
        "[CRITICAL WORKER CRASH] litellm.APIConnectionError: OllamaException - "
        "{\"error\":\"error parsing tool call: raw='{\\\"name\\\":\\\"write_file\\\","
        "\\\"arguments\\\":{\\\"content\\\":\\\"very long code\\\"}', err=unexpected end of JSON input\"}"
    )

    sanitized = _sanitize_skill_result_for_prompt(result)

    assert sanitized == "[CRITICAL WORKER CRASH: model produced invalid/truncated JSON tool-call arguments.]"
    assert "write_file" not in sanitized


def test_tool_calls_count_accepts_int_like_values():
    assert _tool_calls_count(0) == 0
    assert _tool_calls_count("2") == 2
    assert _tool_calls_count("?") is None


def test_run_skill_worker_disables_shared_router(tmp_path, monkeypatch):
    """Worker sub-agents must not reuse a LiteLLM Router created for the orchestrator."""
    import opalatex.memgpt_runtime as runtime
    from types import SimpleNamespace

    captured = {}

    class FakeLLMAgentBlock:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.name = kwargs.get("name", "")
            self.model = kwargs.get("model", "")
            self.tools = kwargs.get("tools", [])
            self.model_kwargs = kwargs.get("model_kwargs", {})
            self.on_iteration = None
            self.on_thinking = None
            self.on_chunk = None

        async def _acompletion(self, _messages, **_kwargs):
            return SimpleNamespace(choices=[])

        async def run(self, _input):
            return SimpleNamespace(response="done", tool_calls_made=1)

    monkeypatch.setattr(runtime, "LLMAgentBlock", FakeLLMAgentBlock)
    project = _project(tmp_path)
    project.mode = "auto"
    project.worker_model = "ollama/gemma4:26b"
    m = build_chat_orchestrator(project, None)
    run_skill = build_run_skill_tool(
        m,
        str(tmp_path),
        project_model=project.model,
        project_worker=project.worker_model,
        _project_ref=project,
    )
    raw = getattr(run_skill, "_func", None) or run_skill

    result = asyncio.run(raw("command-line", "inspect the project"))

    assert "done" in result
    assert captured["model"] == "ollama/gemma4:26b"
    assert captured["use_shared_router"] is False
    assert "search_code" in {getattr(tool, "name", None) for tool in captured["tools"]}



def test_build_chat_orchestrator_scopes_project_path(tmp_path):
    """Regression: building the MemGPT must set the global project context so the
    sub-agent's file tools act inside the project, not the OpalaTex repo root."""
    from opalatex.tools import get_project_path
    build_chat_orchestrator(_project(tmp_path), None)
    assert os.path.abspath(get_project_path()) == os.path.abspath(str(tmp_path))

def test_chat_orchestrator_ignores_legacy_agent_error_in_model_history(tmp_path):
    project = _project(tmp_path)
    project.history = [
        {"role": "user", "content": "Explain transformers."},
        {"role": "assistant", "content": "Agent Error: Could not connect to ollama_chat/gpt-oss:20b."},
        {"role": "user", "content": "Continue."},
    ]

    agent = build_chat_orchestrator(project, None)
    contents = [message["content"] for message in agent.internal_history]

    assert "Explain transformers." in contents
    assert "Continue." in contents
    assert not any(str(content).startswith("Agent Error:") for content in contents)

def test_memgpt_retries_ollama_invalid_json_tool_call_with_heartbeat():
    from types import SimpleNamespace
    from agenticblocks.blocks.llm.agent import AgentInput
    from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock

    agent = MemGPTAgentBlock(
        name="retry-test",
        model="ollama_chat/gpt-oss:20b",
        max_heartbeats=2,
        system_prompt="test",
    )
    calls = []

    async def fake_completion(_messages, **_kwargs):
        calls.append([dict(message) for message in _messages])
        if len(calls) == 1:
            raise Exception(
                "Ollama_chatException - error parsing tool call: "
                "invalid character ',' in string escape code"
            )
        tool_call = SimpleNamespace(
            id="call_1",
            function=SimpleNamespace(
                name="send_message",
                arguments='{"message":"Recovered response","request_heartbeat":false}',
            ),
        )
        message = SimpleNamespace(
            content="",
            reasoning_content=None,
            tool_calls=[tool_call],
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)

    agent._acompletion = fake_completion
    result = asyncio.run(agent.run(AgentInput(prompt="test")))

    assert result.response == "Recovered response"
    assert len(calls) == 2
    assert "native tool-calling API" in calls[1][-1]["content"]

def test_memgpt_returns_plain_json_content_without_tool_recovery():
    from types import SimpleNamespace
    from agenticblocks.blocks.llm.agent import AgentInput
    from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock

    response_text = '```json\n{"name":"send_message","arguments":{"message":"example"}}\n```'
    agent = MemGPTAgentBlock(
        name="json-response-test",
        model="test/model",
        max_heartbeats=2,
        system_prompt="test",
    )
    calls = []

    async def fake_completion(_messages, **_kwargs):
        calls.append(_kwargs)
        message = SimpleNamespace(
            content=response_text,
            reasoning_content=None,
            tool_calls=[],
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)

    agent._acompletion = fake_completion
    result = asyncio.run(agent.run(AgentInput(prompt="Show a JSON example.")))

    assert result.response == response_text
    assert result.tool_calls_made == 0
