"""Tests for the /models, /set-main-model, /set-worker-model REPL commands
and per-project worker_model persistence."""

import asyncio
import os
import tempfile


from opalatex.cli_commands import REPLState, _registry
from opalatex.project import ProjectStore
from opalatex.memgpt_runtime import resolve_skill_model


def _state(tmp_path):
    db = os.path.join(str(tmp_path), "s.db")
    store = ProjectStore(db_path=db)
    p = store.create(name="t", mode="auto", model="ollama/test-model",
                     project_name="t", project_path=str(tmp_path))
    return REPLState(p, store), store


def test_set_main_model_persists(tmp_path):
    state, store = _state(tmp_path)
    asyncio.run(_registry.dispatch(state, "/set-main-model", ["ollama/mistral-nemo"]))
    assert state.project.model == "ollama/mistral-nemo"
    assert store.load("t").model == "ollama/mistral-nemo"


def test_set_worker_model_persists(tmp_path):
    state, store = _state(tmp_path)
    asyncio.run(_registry.dispatch(state, "/set-worker-model", ["gemini/gemini-2.0-flash"]))
    assert state.project.worker_model == "gemini/gemini-2.0-flash"
    assert store.load("t").worker_model == "gemini/gemini-2.0-flash"


def test_worker_model_resolves_for_skill(tmp_path):
    """A skill declaring model: worker resolves to the project's worker model."""
    state, _ = _state(tmp_path)
    asyncio.run(_registry.dispatch(state, "/set-worker-model", ["gemini/custom"]))
    resolved = resolve_skill_model({"model": "worker"},
                                   state.project.model, state.project.worker_model)
    assert resolved == "gemini/custom"


def test_worker_model_falls_back_to_global_when_unset(tmp_path):
    from opalatex.config import DEFAULT_MODEL
    state, _ = _state(tmp_path)
    # No project worker set → resolve_skill_model uses the main project model.
    resolved = resolve_skill_model({"model": "worker"}, state.project.model, "")
    assert resolved == state.project.model


def test_clear_preserves_models(tmp_path):
    """/clear must not reset the project's main/worker model."""
    state, store = _state(tmp_path)
    asyncio.run(_registry.dispatch(state, "/set-main-model", ["ollama/m1"]))
    asyncio.run(_registry.dispatch(state, "/set-worker-model", ["gemini/a1"]))
    # Patch confirm to auto-yes
    import opalatex.terminal as T
    orig = T.confirm
    T.confirm = lambda *a, **k: True
    try:
        asyncio.run(_registry.dispatch(state, "/clear", []))
    finally:
        T.confirm = orig
    assert state.project.model == "ollama/m1"
    assert state.project.worker_model == "gemini/a1"


def test_old_db_migrates_without_worker_model_column(tmp_path):
    """A pre-existing DB lacking the worker_model column migrates cleanly."""
    import sqlite3
    db = os.path.join(str(tmp_path), "old.db")
    c = sqlite3.connect(db)
    c.executescript(
        "CREATE TABLE projects (name TEXT PRIMARY KEY, created_at TEXT NOT NULL, "
        "updated_at TEXT NOT NULL, mode TEXT DEFAULT 'plan', model TEXT DEFAULT '', "
        "project_name TEXT DEFAULT '', project_path TEXT DEFAULT '', "
        "skills TEXT DEFAULT '[\"opalatex\"]', description TEXT DEFAULT '', "
        "request TEXT DEFAULT '', plan_text TEXT DEFAULT '', subplans TEXT DEFAULT '[]', "
        "results TEXT DEFAULT '{}');"
        "CREATE TABLE project_history (id INTEGER PRIMARY KEY, project TEXT, "
        "timestamp TEXT, role TEXT, content TEXT);"
    )
    c.execute("INSERT INTO projects (name,created_at,updated_at,model) "
              "VALUES ('old','t','t','ollama/old')")
    c.commit(); c.close()

    store = ProjectStore(db_path=db)  # __init__ runs the migration
    p = store.load("old")
    assert p.model == "ollama/old"        # existing data preserved
    assert p.worker_model == ""      # new column defaults empty
    p.worker_model = "gemini/x"
    store.save(p)
    assert store.load("old").worker_model == "gemini/x"


def test_set_model_param_valid(tmp_path):
    state, store = _state(tmp_path)
    # Known numeric params
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["temperature", "0.8"]))
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["num_ctx", "4096"]))
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["think", "1024"]))
    assert state.project.model_params["temperature"] == 0.8
    assert state.project.model_params["num_ctx"] == 4096
    assert state.project.model_params["think"] == 1024
    assert store.load("t").model_params["temperature"] == 0.8
    assert store.load("t").model_params["num_ctx"] == 4096
    assert store.load("t").model_params["think"] == 1024

    # Any arbitrary LiteLLM param is now accepted
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["reasoning_effort", "medium"]))
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["seed", "42"]))
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["top_k", "50"]))
    assert state.project.model_params["reasoning_effort"] == "medium"
    assert state.project.model_params["seed"] == 42
    assert state.project.model_params["top_k"] == 50

    # Boolean coercion
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["think", "true"]))
    assert state.project.model_params["think"] is True
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["think", "false"]))
    assert state.project.model_params["think"] is False


def test_set_model_param_invalid(tmp_path):
    state, store = _state(tmp_path)
    # Invalid parameter name (contains spaces / special chars)
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["bad name!", "1.0"]))
    assert "bad name!" not in state.project.model_params

    # Missing value → usage error, param not set
    asyncio.run(_registry.dispatch(state, "/set-model-param", ["temperature"]))
    assert "temperature" not in state.project.model_params


def test_commit_and_undo_commands(tmp_path):
    state, store = _state(tmp_path)
    
    # The project path is tmp_path. Let's create a file inside it to commit.
    test_file = os.path.join(str(tmp_path), "test_doc.txt")
    with open(test_file, "w") as f:
        f.write("hello world")
        
    # Dispatch "/commit"
    res = asyncio.run(_registry.dispatch(state, "/commit", ["first user commit"]))
    assert res == "continue"
    
    # Verify the file is now tracked/committed (i.e. git has no untracked files)
    from opalatex.vcs import get_vcs_strategy
    from opalatex.config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    
    # We should be able to run "/undo"
    res_undo = asyncio.run(_registry.dispatch(state, "/undo", []))
    assert res_undo == "continue"
    
    # Since we did /undo, the file "test_doc.txt" should be removed by git clean -fd
    assert not os.path.exists(test_file)

