"""Regression tests for the "a project starts with no model configured" rule.

Covers:
1. Creating a project without a model must not inject an implicit default.
2. update-project must be able to change *and* clear the model selection, so the
   chat model selector and the project settings dialog always agree.
3. Running the chat orchestrator on a project with no model must fail fast with a
   clear diagnostic instead of silently falling back to DEFAULT_MODEL.
"""

import os
import tempfile

import pytest

from opalatex.project import ProjectStore


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(db_path=str(tmp_path / "sessions.db"))


def test_project_created_without_model_stays_unconfigured(store, tmp_path):
    project = store.create(
        name="p1",
        mode="auto",
        model="",
        project_name="P1",
        project_path=str(tmp_path / "p1"),
    )

    assert project.model == ""
    assert project.worker_model == ""

    listed = store.list_projects()[0]
    assert listed["model"] == ""
    assert listed["worker_model"] == ""


def test_model_selection_round_trips_through_the_store(store, tmp_path):
    store.create(
        name="p1",
        mode="auto",
        model="",
        project_name="P1",
        project_path=str(tmp_path / "p1"),
    )

    project = store.load("p1")
    project.model = "ollama/qwen3.5:cloud"
    project.worker_model = "ollama/qwen3.5:cloud"
    store.save(project)

    listed = store.list_projects()[0]
    assert listed["model"] == "ollama/qwen3.5:cloud"
    assert listed["worker_model"] == "ollama/qwen3.5:cloud"

    # The selection must also be clearable, back to the unconfigured state.
    project = store.load("p1")
    project.model = ""
    project.worker_model = ""
    store.save(project)

    listed = store.list_projects()[0]
    assert listed["model"] == ""
    assert listed["worker_model"] == ""


@pytest.mark.asyncio
async def test_handle_run_refuses_project_without_model(monkeypatch):
    import opalatex.agent_stdin as stdin_mod

    events = []

    class FakeMemGPT:
        async def run(self, agent_input):  # pragma: no cover - must not be reached
            raise AssertionError("the agent must not run without a configured model")

    with tempfile.TemporaryDirectory() as tmp:
        store = ProjectStore(db_path=os.path.join(tmp, "sessions.db"))
        project = store.create(
            name="p1",
            mode="auto",
            model="",
            project_name="P1",
            project_path=os.path.join(tmp, "p1"),
        )

        monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
        monkeypatch.setattr(stdin_mod, "current_project", project)
        monkeypatch.setattr(stdin_mod, "current_store", store)
        monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())

        await stdin_mod.handle_run({"agent": "chat_orchestrator", "prompt": "hello"})

    error_events = [data for event, data in events if event == "error"]
    assert error_events, f"expected an error event, got {[e for e, _ in events]}"
    assert "model" in error_events[0]["message"].lower()
    assert [event for event, _ in events if event == "agent_finished"]


@pytest.mark.asyncio
async def test_handle_run_accepts_project_with_configured_model(monkeypatch):
    """The guard must only trigger on the unconfigured case."""
    import opalatex.agent_stdin as stdin_mod
    from types import SimpleNamespace

    events = []
    ran = []

    class FakeMemGPT:
        internal_history = []
        _current_worker_messages = []
        _last_worker_summary = ""
        model = "ollama/qwen3.5:cloud"

        async def _acompletion(self, *args, **kwargs):
            return None

        async def run(self, agent_input):
            ran.append(agent_input.prompt)
            return SimpleNamespace(response="ok")

    with tempfile.TemporaryDirectory() as tmp:
        store = ProjectStore(db_path=os.path.join(tmp, "sessions.db"))
        project = store.create(
            name="p1",
            mode="auto",
            model="ollama/qwen3.5:cloud",
            project_name="P1",
            project_path=os.path.join(tmp, "p1"),
        )

        monkeypatch.setattr(stdin_mod, "print_event", lambda event, data: events.append((event, data)))
        monkeypatch.setattr(stdin_mod, "current_project", project)
        monkeypatch.setattr(stdin_mod, "current_store", store)
        monkeypatch.setattr(stdin_mod, "current_memgpt", FakeMemGPT())

        await stdin_mod.handle_run({"agent": "chat_orchestrator", "prompt": "hello"})

    assert ran, "the agent should run when the project has a configured model"
    assert not [data for event, data in events if event == "error"]
