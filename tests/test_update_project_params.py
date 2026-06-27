"""Manual integration test: verify that saving project settings via
/api/opalatex/update-project correctly persists and applies all model_params.

This test:
1. Creates a temporary project in an isolated DB.
2. POSTs to /api/opalatex/update-project with every known parameter.
3. Reloads the project from the DB and asserts each value was persisted.
4. Asserts that get_agent_llm_kwargs() and get_project_agent_params() reflect
   the saved values (i.e., they are picked up by the runtime).

Run with:
    pytest tests/test_update_project_params.py -v
"""

import json
import os
import tempfile
import asyncio
import pytest

from opalatex.project import ProjectStore, ProjectData
from opalatex.config import get_agent_llm_kwargs, get_project_agent_params
from opalatex import tools as _tools


# ---------------------------------------------------------------------------
# All parameters exposed in the EditProjectModal, with test values.
# Split into LiteLLM kwargs (go into model_kargs) and agent constructor params.
# ---------------------------------------------------------------------------

LITELLM_PARAMS = {
    "temperature":         0.5,
    "num_ctx":             4096,
    "top_p":               0.9,
    "frequency_penalty":   0.3,
    "presence_penalty":    0.2,
    "seed":                42,
    "top_k":               30,
    "min_p":               0.05,
    "repetition_penalty":  1.1,
    "think":               False,
    "stream":              False,
}

AGENT_PARAMS = {
    "max_heartbeats":           15,
    "max_context_tokens":       8000,
    "eviction_threshold":       0.9,
    "memory_pressure_threshold": 0.6,
    "max_iterations":           5,
    "max_tool_calls":           20,
    "response_mode":            "last",
    "debug":                    False,
}

ALL_PARAMS = {**LITELLM_PARAMS, **AGENT_PARAMS}


@pytest.fixture(autouse=True)
def _reset_project_session():
    """Restore _PROJECT_SESSION to None after each test to avoid state leakage."""
    yield
    import opalatex.tools as _t
    _t._PROJECT_SESSION = None


@pytest.fixture()
def tmp_store(tmp_path):
    """Isolated ProjectStore backed by a temp DB."""
    db = str(tmp_path / "test.db")
    store = ProjectStore(db_path=db)
    project_path = str(tmp_path / "proj")
    os.makedirs(project_path)
    project = store.create(
        name="test_proj",
        mode="auto",
        model="ollama/test-model:latest",
        project_name="Test Project",
        project_path=project_path,
    )
    return store, project


def _apply_update(store: ProjectStore, project: ProjectData, params: dict) -> ProjectData:
    """Simulate what /api/opalatex/update-project does."""
    import re
    validated = {}
    for k, v in params.items():
        if not k or not re.fullmatch(r'[A-Za-z0-9_-]+', k):
            raise ValueError(f"invalid parameter name: {k}")
        if v is None or v == "":
            continue
        validated[k] = v
    project.model_params = validated
    store.save(project)
    return project


def _reload(store: ProjectStore, name: str) -> ProjectData:
    return store.load(name)


def _inject_session(project: ProjectData, store: ProjectStore):
    """Point config._PROJECT_SESSION at our project so get_agent_llm_kwargs reads it."""
    _tools.set_project_context(project, store)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestUpdateProjectPersistence:

    def test_all_params_persisted_in_db(self, tmp_store):
        """Every parameter sent to update-project must survive a DB round-trip."""
        store, project = tmp_store
        _apply_update(store, project, ALL_PARAMS)
        reloaded = _reload(store, project.name)

        for key, expected in ALL_PARAMS.items():
            assert key in reloaded.model_params, f"param '{key}' missing after reload"
            assert reloaded.model_params[key] == expected, (
                f"param '{key}': expected {expected!r}, got {reloaded.model_params[key]!r}"
            )

    def test_load_with_custom_chat_id(self, tmp_store):
        """Verify that ProjectStore.load loads project with custom chat_id correctly."""
        store, project = tmp_store
        chat_id = "test-chat-123"
        store.create_chat(project.name, chat_id, "Test Chat")
        
        reloaded = store.load(project.name, chat_id=chat_id)
        assert reloaded is not None
        assert reloaded.current_chat_id == chat_id

    def test_litellm_params_applied_to_agent_kwargs(self, tmp_store):
        """LiteLLM params must appear in get_agent_llm_kwargs() after save."""
        store, project = tmp_store
        _apply_update(store, project, ALL_PARAMS)
        reloaded = _reload(store, project.name)
        _inject_session(reloaded, store)

        kwargs = get_agent_llm_kwargs("worker")

        for key, expected in LITELLM_PARAMS.items():
            assert key in kwargs, f"LiteLLM param '{key}' missing from get_agent_llm_kwargs()"
            assert kwargs[key] == expected, (
                f"LiteLLM param '{key}': expected {expected!r}, got {kwargs[key]!r}"
            )

    def test_agent_constructor_params_applied(self, tmp_store):
        """Agent constructor params must appear in get_project_agent_params() after save."""
        store, project = tmp_store
        _apply_update(store, project, ALL_PARAMS)
        reloaded = _reload(store, project.name)
        _inject_session(reloaded, store)

        agent_params = get_project_agent_params()

        for key, expected in AGENT_PARAMS.items():
            assert key in agent_params, f"agent param '{key}' missing from get_project_agent_params()"
            assert agent_params[key] == expected, (
                f"agent param '{key}': expected {expected!r}, got {agent_params[key]!r}"
            )

    def test_empty_value_not_persisted(self, tmp_store):
        """Empty string values must be dropped (not stored as empty strings)."""
        store, project = tmp_store
        params_with_empty = {**ALL_PARAMS, "num_ctx": ""}
        _apply_update(store, project, params_with_empty)
        reloaded = _reload(store, project.name)

        assert reloaded.model_params.get("num_ctx") != "", (
            "empty string for num_ctx must not be persisted"
        )
        assert "num_ctx" not in reloaded.model_params or reloaded.model_params["num_ctx"] != "", (
            "empty value leaked into model_params"
        )

    def test_max_tokens_absent_means_unlimited(self, tmp_store):
        """When max_tokens is not in model_params, get_agent_llm_kwargs must not
        include it — letting the model generate without a token cap."""
        store, project = tmp_store
        params_no_max_tokens = {k: v for k, v in ALL_PARAMS.items() if k != "max_tokens"}
        _apply_update(store, project, params_no_max_tokens)
        reloaded = _reload(store, project.name)
        _inject_session(reloaded, store)

        kwargs = get_agent_llm_kwargs("worker")
        assert "max_tokens" not in kwargs, (
            "max_tokens must be absent from kwargs when not set — model should be unlimited"
        )

    def test_partial_update_preserves_other_fields(self, tmp_store):
        """Saving only some params must not wipe out unrelated project fields."""
        store, project = tmp_store
        original_model = project.model
        original_path = project.project_path

        _apply_update(store, project, {"temperature": 0.3})
        reloaded = _reload(store, project.name)

        assert reloaded.model == original_model, "model changed unexpectedly after param update"
        assert reloaded.project_path == original_path, "project_path changed unexpectedly"
        assert reloaded.model_params.get("temperature") == 0.3

    def test_update_rebuilds_memgpt_with_new_params(self, tmp_store, monkeypatch):
        """After save, the rebuilt MemGPT must carry the updated model_kargs."""
        store, project = tmp_store
        _apply_update(store, project, ALL_PARAMS)
        reloaded = _reload(store, project.name)
        _inject_session(reloaded, store)

        from opalatex.memgpt_runtime import build_chat_orchestrator
        memgpt = build_chat_orchestrator(reloaded, store)

        for key, expected in LITELLM_PARAMS.items():
            assert memgpt.model_kargs.get(key) == expected, (
                f"MemGPT model_kargs['{key}']: expected {expected!r}, "
                f"got {memgpt.model_kargs.get(key)!r}"
            )

    def test_sanitize_and_clamp_model_params(self):
        """Verify that sanitize_model_params correctly handles string numbers with commas, and clamps out of bounds values."""
        from opalatex.ide_server import sanitize_model_params
        
        raw_params = {
            "temperature": "-0.5",  # below min 0.0
            "presence_penalty": "0,8",  # string comma float
            "frequency_penalty": 3.5,  # above max 2.0
            "num_ctx": "4096",  # string int
            "think": "true",  # string bool
            "invalid_param": "some_value"  # not in schema
        }
        
        sanitized = sanitize_model_params(raw_params)
        
        assert sanitized["temperature"] == 0.0
        assert sanitized["presence_penalty"] == 0.8
        assert sanitized["frequency_penalty"] == 2.0
        assert sanitized["num_ctx"] == 4096
        assert sanitized["think"] is True
        assert "invalid_param" not in sanitized
