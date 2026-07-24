"""Tests for the stdin/stdout agent server protocol."""

import json
import io
import sys
import asyncio
import shutil
import subprocess
import pytest
from unittest.mock import MagicMock, AsyncMock
from types import SimpleNamespace

from opalatex.agent_stdin import (
    print_event,
    wrap_tool,
    patched_get_available_tools,
    handle_load_project,
    _empty_response_failure_message,
    _friendly_llm_error,
    _looks_like_degenerate_thought,
    _record_turn_thought,
    _response_with_thought,
    _sanitize_model_response,
    _visible_chat_response,
    _worker_summary_response,
    clear_worker_message_buffer,
    record_worker_message,
)


def test_degenerate_thought_detection_catches_repeated_unicode_escape():
    repeated = r"\u2013" * 80

    assert _looks_like_degenerate_thought(repeated)


def test_record_turn_thought_suppresses_degenerate_chunks(monkeypatch):
    import opalatex.agent_stdin as stdin_mod

    chunks = []
    monkeypatch.setattr(stdin_mod, "_ACTIVE_THOUGHT_CHUNKS", chunks)
    monkeypatch.setattr(stdin_mod, "_ACTIVE_THOUGHT_CHARS", 0)
    monkeypatch.setattr(stdin_mod, "_ACTIVE_THOUGHT_SUPPRESSED", False)

    assert not _record_turn_thought(r"\u2013" * 80)
    assert len(chunks) == 1
    assert "Thought stream suppressed" in chunks[0]

    assert not _record_turn_thought("more repeated noise")
    assert len(chunks) == 1

def test_print_event(monkeypatch):
    """Verify that print_event writes a JSON line containing the event and data to the real stdout."""
    # Create a dummy stream to capture real stdout
    stream = io.StringIO()
    # Temporarily monkeypatch the module's _real_stdout
    import opalatex.agent_stdin
    monkeypatch.setattr(opalatex.agent_stdin, "_real_stdout", stream)

    print_event("test_event", {"foo": "bar", "num": 123})
    
    stream.seek(0)
    output = stream.read().strip()
    
    # Verify the printed event is valid JSON and matches expected values
    parsed = json.loads(output)
    assert parsed["event"] == "test_event"
    assert parsed["foo"] == "bar"
    assert parsed["num"] == 123


def test_wrap_tool():
    """Verify that wrap_tool correctly wraps a sync function as an AgenticBlocks tool."""
    # Define a simple function to wrap
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    wrapped = wrap_tool(add)
    assert wrapped.name == "add"
    assert "Add two numbers" in wrapped.description
    
    # We can invoke the wrapped function via its raw _func attribute or directly
    raw = getattr(wrapped, "_func", None) or wrapped
    assert raw(2, 3) == 5


@pytest.mark.asyncio
async def test_wrap_tool_async():
    """Verify that wrap_tool correctly wraps an async function."""
    async def multiply(a: int, b: int) -> int:
        """Multiply two numbers."""
        await asyncio.sleep(0.001)
        return a * b

    wrapped = wrap_tool(multiply)
    assert wrapped.name == "multiply"
    assert "Multiply two numbers" in wrapped.description
    
    raw = getattr(wrapped, "_func", None) or wrapped
    res = await raw(3, 4)
    assert res == 12


def test_patched_get_available_tools():
    """Verify that patched_get_available_tools returns wrapped tools."""
    tools = patched_get_available_tools()
    assert len(tools) > 0
    # Every tool returned should be wrapped (which can be checked if its function is wrapped)
    # The wrapped function will have the wrapped decorators applied.
    for t in tools:
        assert hasattr(t, "name")
        assert hasattr(t, "description")


def test_empty_response_failure_message_is_localized():
    from opalatex.i18n import set_lang

    set_lang("en")
    assert _empty_response_failure_message() == "The agent finished without calling send_message after automatic correction attempts. No fallback response was saved."

    set_lang("pt")
    assert _empty_response_failure_message() == "O agente terminou sem chamar send_message após as tentativas automáticas de correção. Nenhuma resposta fallback foi salva."


def test_ollama_model_not_found_error_is_localized():
    from opalatex.i18n import set_lang

    project = SimpleNamespace(model="ollama/gemma")
    exc = Exception("model not found, try pulling it first")

    set_lang("en")
    en_msg = _friendly_llm_error(exc, project)
    assert "The model `gemma` was not found locally" in en_msg
    assert "O modelo" not in en_msg

    set_lang("pt")
    pt_msg = _friendly_llm_error(exc, project)
    assert "O modelo `gemma` não foi encontrado localmente" in pt_msg


def test_insufficient_quota_error_is_localized():
    from opalatex.i18n import set_lang
    project = SimpleNamespace(model="openai/gpt-5.5")
    exc = Exception("OpenAIException - {\"error\": {\"message\": \"You exceeded your current quota, please check your plan and billing details.\", \"type\": \"insufficient_quota\"}}")

    set_lang("en")
    en_msg = _friendly_llm_error(exc, project)
    assert "insufficient credits" in en_msg.lower() or "billing settings" in en_msg.lower()

    set_lang("pt")
    pt_msg = _friendly_llm_error(exc, project)
    assert "cota de uso" in pt_msg.lower() or "créditos suficientes" in pt_msg.lower()


def test_worker_summary_response_prefers_current_worker_messages():
    clear_worker_message_buffer()
    record_worker_message("stale recorded worker message")

    class Agent:
        _current_worker_messages = ["Created test.tex successfully."]
        _last_worker_summary = "stale summary"

    assert _worker_summary_response(Agent()) == "Created test.tex successfully."
    clear_worker_message_buffer()


def test_worker_summary_response_falls_back_to_last_worker_summary():
    clear_worker_message_buffer()

    class Agent:
        _current_worker_messages = []
        _last_worker_summary = "Worker finished the requested task."

    assert _worker_summary_response(Agent()) == "Worker finished the requested task."


def test_worker_summary_response_prefers_last_worker_chat_response():
    clear_worker_message_buffer()

    class Agent:
        _last_worker_chat_response = "Visible worker response."
        _current_worker_messages = []
        _last_worker_summary = "older summary"

    assert _worker_summary_response(Agent()) == "Visible worker response."


def test_worker_summary_response_prefers_visible_intermediate_agent_response():
    clear_worker_message_buffer()

    import opalatex.agent_stdin as stdin_mod

    original_hook = stdin_mod.event_hook
    stdin_mod.event_hook = lambda _payload: None
    try:
        stdin_mod.print_event("agent_response", {
            "response": "Already visible in chat.",
            "intermediate": True,
        })
    finally:
        stdin_mod.event_hook = original_hook

    class Agent:
        _last_worker_chat_response = ""
        _current_worker_messages = []
        _last_worker_summary = ""
        internal_history = []

    assert _worker_summary_response(Agent()) == "Already visible in chat."
    clear_worker_message_buffer()


def test_worker_summary_response_extracts_run_skill_tool_result():
    clear_worker_message_buffer()

    class Agent:
        _current_worker_messages = []
        _last_worker_summary = ""
        internal_history = [
            {
                "role": "tool",
                "content": (
                    "[skill 'command-line' finished] Worker's summary/report:\n"
                    "(Tools used by worker: 2)\n"
                    "Created test.tex and saved the requested LaTeX article."
                ),
            }
        ]

    assert _worker_summary_response(Agent()) == "Created test.tex and saved the requested LaTeX article."


def test_worker_summary_response_uses_recorded_worker_message_when_agent_has_no_summary():
    clear_worker_message_buffer()
    record_worker_message("Worker send_message reached stdout.")

    class Agent:
        _current_worker_messages = []
        _last_worker_summary = ""
        internal_history = []

    assert _worker_summary_response(Agent()) == "Worker send_message reached stdout."
    clear_worker_message_buffer()


def test_response_with_thought_returns_visible_chat_content_only():
    assert _response_with_thought("Done.", ["Thinking 1\n", "Thinking 2"]) == "Done."
    assert _response_with_thought("Done.", []) == "Done."
    assert _response_with_thought("<think>\nAlready wrapped\n</think>\n\nDone.", ["Thought"]) == "Done."


def test_visible_chat_response_strips_thought_blocks():
    assert _visible_chat_response("Done.") == "Done."
    assert _visible_chat_response("<think>\nold\n</think>\n\nDone.") == "Done."
    assert _visible_chat_response("<think>\n\n</think>\n\nDone.") == "Done."


def test_visible_chat_response_strips_reasoning_channels():
    assert _visible_chat_response(
        "<|channel|>analysis<|message|>private note<|end|>"
        "<|channel|>final<|message|>Visible answer."
    ) == "Visible answer."



def test_sanitize_model_response_moves_channel_thought_to_snapshot():
    thoughts = []

    visible = _sanitize_model_response(
        (
            "<think>\n\n</think>\n"
            "<|channel|>thought<|message|>I should inspect the prompt.<|end|>"
            "<|channel|>final<|message|>Here is the explanation."
        ),
        thoughts,
    )

    assert visible == "Here is the explanation."
    assert thoughts == ["I should inspect the prompt."]


def test_sanitize_model_response_consolidates_multiple_think_blocks():
    thoughts = ["live thought."]

    visible = _sanitize_model_response(
        "<think>first internal note</think>\n\nVisible answer.\n\n<think>second internal note</think>",
        thoughts,
    )

    assert visible == "Visible answer."
    assert thoughts == ["live thought.", "first internal note", "second internal note"]


def test_sanitize_model_response_treats_thought_only_channel_as_empty_response():
    thoughts = []

    visible = _sanitize_model_response(
        "<|channel|>thought\nWait, I see what happened.",
        thoughts,
    )

    assert visible == ""
    assert thoughts == ["Wait, I see what happened."]


@pytest.mark.asyncio
async def test_handle_run_retries_orchestrator_before_using_worker_summary(monkeypatch):
    import opalatex.agent_stdin as stdin_mod

    events = []
    prompts = []

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        calls = 0

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, agent_input):
            self.calls += 1
            prompts.append(agent_input.prompt)
            if self.calls == 1:
                self._current_worker_messages = ["Worker created test.tex successfully."]
                return SimpleNamespace(response="")
            return SimpleNamespace(response="Created test.tex successfully. Please verify the file.")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", None)
    monkeypatch.setattr(stdin_mod, "current_store", None)

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "create test.tex",
    })

    assert len(prompts) == 2
    assert "Worker created test.tex successfully." in prompts[1]
    assert "send_message" in prompts[1]
    agent_responses = [data["response"] for event, data in events if event == "agent_response"]
    assert agent_responses == ["Created test.tex successfully. Please verify the file."]


@pytest.mark.asyncio
async def test_handle_run_does_not_promote_worker_message_without_orchestrator_response(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod
    from opalatex.memgpt_runtime import make_intercepted_send_message

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        _last_worker_chat_response = ""
        _worker_response_emitted = False
        calls = 0

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, agent_input):
            self.calls += 1
            if self.calls == 1:
                send_message = make_intercepted_send_message(self, "command-line")
                raw = getattr(send_message, "_func", None) or send_message
                raw("Worker created test.tex successfully.")
                self._current_worker_messages = []
                self._last_worker_summary = ""
                return SimpleNamespace(response="")
            assert "Worker created test.tex successfully." in agent_input.prompt
            assert "send_message" in agent_input.prompt
            return SimpleNamespace(response="The file test.tex was created. Please verify it.")

    fake_agent = FakeMemGPT()
    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", fake_agent)
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "create test.tex",
    })

    assistant_messages = [content for role, content in saved_messages if role == "assistant"]
    assert assistant_messages == ["The file test.tex was created. Please verify it."]

    agent_responses = [data["response"] for event, data in events if event == "agent_response"]
    assert agent_responses == ["The file test.tex was created. Please verify it."]
    assert fake_agent.calls == 2


@pytest.mark.asyncio
async def test_handle_run_reports_error_when_orchestrator_never_sends_message(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod
    from opalatex.i18n import set_lang

    set_lang("en")

    events = []
    saved_messages = []
    prompts = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        _last_worker_chat_response = ""
        _worker_response_emitted = False

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, agent_input):
            prompts.append(agent_input.prompt)
            self._current_worker_messages = ["Worker claims it completed the job."]
            return SimpleNamespace(response="")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "create test.tex",
    })

    assistant_messages = [content for role, content in saved_messages if role == "assistant"]
    assert assistant_messages == [
        "Agent Error: The agent finished without calling send_message after automatic correction attempts. No fallback response was saved."
    ]

    agent_responses = [data["response"] for event, data in events if event == "agent_response"]
    assert agent_responses == []
    errors = [data["message"] for event, data in events if event == "error"]
    assert errors == [
        "The agent finished without calling send_message after automatic correction attempts. No fallback response was saved."
    ]
    assert len(prompts) == 3
    assert "send_message" in prompts[1]
    assert "send_message" in prompts[2]
    assert "O trabalho solicitado parece ter sido concluído" not in "\n".join(agent_responses)


@pytest.mark.asyncio
async def test_handle_run_does_not_duplicate_user_message_on_failed_retries(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod
    from opalatex.project import ProjectStore

    db_path = str(tmp_path / "projects.db")
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    store = ProjectStore(db_path=db_path)
    project = store.create(
        name="proj",
        mode="auto",
        model="fake/model",
        project_name="Project",
        project_path=str(project_dir),
    )

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        _last_worker_chat_response = ""
        _worker_response_emitted = False

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            raise RuntimeError("simulated api failure")

    events = []
    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", project)
    monkeypatch.setattr(stdin_mod, "current_store", store)

    payload = {
        "agent": "chat_orchestrator",
        "prompt": "review main.tex",
        "client_message_id": "client-turn-1",
    }
    await stdin_mod.handle_run(payload)
    await stdin_mod.handle_run(payload)
    await stdin_mod.handle_run(payload)

    loaded = store.load("proj", chat_id=project.current_chat_id)
    # User message must appear exactly once (no duplicates despite 3 retried calls)
    user_messages = [(m["role"], m["content"]) for m in loaded.history if m["role"] == "user"]
    assert user_messages == [("user", "review main.tex")]
    assert loaded.history[0].get("client_message_id") == "client-turn-1" or any(
        m.get("client_message_id") == "client-turn-1" for m in loaded.history if m["role"] == "user"
    )
    # Each handle_run call records a [MODE] system entry at turn start
    mode_messages = [m for m in loaded.history if m["role"] == "system" and m["content"].startswith("[MODE] Agent turn started")]
    assert len(mode_messages) == 3, f"Expected 3 [MODE] entries, got {len(mode_messages)}"
    assistant_errors = [m["content"] for m in loaded.history if m["role"] == "assistant"]
    assert assistant_errors == [
        "Agent Error: simulated api failure",
        "Agent Error: simulated api failure",
        "Agent Error: simulated api failure",
    ]
    assert [data["message"] for event, data in events if event == "error"] == [
        "simulated api failure",
        "simulated api failure",
        "simulated api failure",
    ]



@pytest.mark.asyncio
async def test_handle_run_persists_visible_response_without_thought_snapshot(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        on_thinking = None

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            self.on_thinking("I should save the file.")
            return SimpleNamespace(response="The file was saved.")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "save file",
    })

    assistant_messages = [content for role, content in saved_messages if role == "assistant"]
    expected_persisted = "The file was saved."
    assert assistant_messages == [expected_persisted]

    agent_responses = [data["response"] for event, data in events if event == "agent_response"]
    assert agent_responses == ["The file was saved."]
    persisted_responses = [data["persisted_response"] for event, data in events if event == "agent_response"]
    assert persisted_responses == [expected_persisted]


@pytest.mark.asyncio
async def test_handle_run_does_not_persist_auxiliary_thought_events_in_chat_history(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        on_thinking = None

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            stdin_mod.print_event("tool_result", {
                "tool": "write_file",
                "result": "ok",
                "is_error": False,
                "agent": "chat_orchestrator",
            })
            return SimpleNamespace(response="The file was saved.")

    monkeypatch.setattr(stdin_mod, "event_hook", lambda payload: events.append(payload))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "save file",
    })

    assistant_messages = [content for role, content in saved_messages if role == "assistant"]
    assert len(assistant_messages) == 1
    assert assistant_messages[0] == "The file was saved."
    assert "<think>" not in assistant_messages[0]
    assert "Received successful return from tool 'write_file'" not in assistant_messages[0]

    agent_responses = [payload["response"] for payload in events if payload["event"] == "agent_response"]
    assert agent_responses == ["The file was saved."]
    persisted_responses = [payload["persisted_response"] for payload in events if payload["event"] == "agent_response"]
    assert persisted_responses == assistant_messages
    thoughts = [payload["content"] for payload in events if payload["event"] == "thought"]
    assert any("Received successful return from tool 'write_file'" in thought for thought in thoughts)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
@pytest.mark.asyncio
async def test_handle_run_checkpoints_direct_file_writes(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            (tmp_path / "script_created.tex").write_text("created outside tools\n", encoding="utf-8")
            return SimpleNamespace(response="Created the file.")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "create file through python",
    })

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    status = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "status",
            "--porcelain",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    assert "Agent turn start checkpoint" in log
    assert "Agent turn end checkpoint" in log
    assert status == ""
    assert (tmp_path / "script_created.tex").read_text(encoding="utf-8") == "created outside tools\n"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
@pytest.mark.asyncio
async def test_handle_run_removes_turn_checkpoints_without_file_changes(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            return SimpleNamespace(response="No file changes were needed.")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "explain only",
    })

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    assert "Agent turn start checkpoint" not in log
    assert "Agent turn end checkpoint" not in log


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
@pytest.mark.asyncio
async def test_handle_run_finalizes_checkpoint_when_agent_errors(monkeypatch, tmp_path):
    import opalatex.agent_stdin as stdin_mod

    events = []
    saved_messages = []

    class FakeProject:
        name = "proj"
        mode = "auto"
        project_path = str(tmp_path)
        model = "fake/model"
        current_chat_id = "main"

    class FakeStore:
        def append_message(self, _project, role, content, attachments=None):
            saved_messages.append((role, content))

        def save(self, _project):
            pass

    class FakeMemGPT:
        model = "fake/model"
        model_kargs = {}
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, _agent_input):
            (tmp_path / "partial.tex").write_text("partial change\n", encoding="utf-8")
            raise RuntimeError("agent failed")

    monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
    monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())
    monkeypatch.setattr(stdin_mod, "current_project", FakeProject())
    monkeypatch.setattr(stdin_mod, "current_store", FakeStore())

    await stdin_mod.handle_run({
        "agent": "chat_orchestrator",
        "prompt": "create file then fail",
    })

    log = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "log",
            "--format=%s",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    status = subprocess.run(
        [
            "git",
            f"--git-dir={tmp_path / '.opalatex' / '.shadowgit'}",
            f"--work-tree={tmp_path}",
            "status",
            "--porcelain",
        ],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    assert "Agent turn start checkpoint" in log
    assert "Agent turn end checkpoint" in log
    assert status == ""
    assert (tmp_path / "partial.tex").read_text(encoding="utf-8") == "partial change\n"


@pytest.mark.asyncio
async def test_project_handlers(tmp_path, monkeypatch):
    """Test project listing, creation, and deletion via stdin handlers."""
    from opalatex.agent_stdin import handle_create_project, handle_list_projects, handle_delete_project
    
    db_file = str(tmp_path / "test_db.sqlite")
    
    # Capture print_event calls
    events = []
    def mock_print_event(event, data):
        events.append((event, data))
        
    import opalatex.agent_stdin
    monkeypatch.setattr(opalatex.agent_stdin, "print_event", mock_print_event)
    
    # 1. Create project
    await handle_create_project({
        "db": db_file,
        "project_name": "Test Project",
        "project_path": str(tmp_path),
        "description": "My test desc",
    })
    
    assert len(events) == 1
    assert events[0][0] == "project_created"
    assert events[0][1]["project_name"] == "Test Project"
    
    # 2. List projects
    events.clear()
    await handle_list_projects({
        "db": db_file,
    })
    assert len(events) == 1
    assert events[0][0] == "projects_list"
    assert len(events[0][1]["projects"]) == 1
    assert events[0][1]["projects"][0]["project_name"] == "Test Project"
    
    # 3. Delete project
    events.clear()
    await handle_delete_project({
        "db": db_file,
        "project_name": "test_project", # name field is db key which is lowercase slug
    })
    assert len(events) == 1
    assert events[0][0] == "project_deleted"
    
    # 4. List projects again (should be empty)
    events.clear()
    await handle_list_projects({
        "db": db_file,
    })
    assert len(events) == 1
    assert len(events[0][1]["projects"]) == 0


def test_skip_directories_in_collect_python_files(tmp_path):
    """Verify that _collect_python_files skips tests, opalatex, skills, and debug directories."""
    from opalatex.tools import _collect_python_files
    import os
    
    # Create structure
    (tmp_path / "opalatex").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "skills").mkdir()
    (tmp_path / "debug").mkdir()
    
    # Write python files inside skipped directories
    (tmp_path / "opalatex" / "main.py").write_text("print('core')")
    (tmp_path / "tests" / "test_app.py").write_text("print('test')")
    (tmp_path / "skills" / "run.py").write_text("print('skill')")
    (tmp_path / "debug" / "debug.py").write_text("print('debug')")
    
    # Write python files in root (should be collected)
    (tmp_path / "app.py").write_text("print('app')")
    
    # Run collector
    collected = _collect_python_files(str(tmp_path), str(tmp_path))
    
    # Assert that only app.py was collected
    collected_basenames = [os.path.basename(f) for f in collected]
    assert "app.py" in collected_basenames
    assert "main.py" not in collected_basenames
    assert "test_app.py" not in collected_basenames
    assert "run.py" not in collected_basenames
    assert "debug.py" not in collected_basenames
    assert len(collected) == 1
