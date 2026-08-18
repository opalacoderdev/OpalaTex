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

# Planning sub-agents: thinking defaults off to avoid unbounded reasoning streams.
SUBAGENT_AGENTS = [
    "landscape_planner",
    "refinement_agent",
]

PLANNING_AGENTS = [
    "orchestrator",
]


from unittest.mock import patch


@pytest.mark.parametrize("agent", PLANNING_AGENTS + ["memgpt"])
def test_orchestrator_agents_enable_thinking_when_model_supports_it(agent):
    """Orchestrator and memgpt may think, but only for models that declare support."""
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            with patch("opalatex.models_store.get_model", return_value={"supports_thinking": True}):
                kwargs = get_agent_llm_kwargs(agent)
            assert kwargs.get("think") is True


@pytest.mark.parametrize("agent", PLANNING_AGENTS + ["memgpt"])
def test_orchestrator_agents_do_not_send_think_without_model_support(agent):
    """Thinking defaults off at the model capability layer unless explicitly enabled."""
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            with patch("opalatex.models_store.get_model", return_value={"supports_thinking": False}):
                kwargs = get_agent_llm_kwargs(agent)
            assert "think" not in kwargs


@pytest.mark.parametrize("agent", TOOL_CALL_AGENTS + SUBAGENT_AGENTS)
def test_subagents_do_not_enable_thinking_by_default(agent):
    """Workers and planning sub-agents default think=False to avoid long reasoning
    streams that can block the agent run indefinitely on complex inputs."""
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            kwargs = get_agent_llm_kwargs(agent)
            assert not kwargs.get("think")


def test_orchestrator_has_large_num_ctx():
    """Orchestrator accumulates long tool-call histories — needs at least 16k context."""
    from unittest.mock import patch
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            kwargs = get_agent_llm_kwargs("orchestrator")
    assert kwargs.get("num_ctx", 0) >= 16384


def test_memgpt_has_large_num_ctx():
    """The MemGPT chat-orchestrator runs multi-turn sessions with skill calls —
    it needs a generous context window so turns are not cut off."""
    from unittest.mock import patch
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            kwargs = get_agent_llm_kwargs("memgpt")
    assert kwargs.get("num_ctx", 0) >= 16384


def test_orchestrator_has_no_restrictive_max_tokens():
    """Orchestrator must not be limited to a small max_tokens — it produces
    long reasoning chains and final reports."""
    from unittest.mock import patch
    with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
        with patch("opalatex.tools._PROJECT_SESSION", None):
            kwargs = get_agent_llm_kwargs("orchestrator")
    max_tok = kwargs.get("max_tokens", None)
    assert max_tok is None or max_tok >= 1024


def test_ollama_cloud_model_uses_remote_api_base_by_default(monkeypatch):
    """Ollama cloud-tagged models must not silently fall back to localhost."""
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "ollama/qwen3.5:cloud"
        model_params = {}
        project_path = "/fake/path"
        api_base = ""
        api_key = ""

    monkeypatch.setenv("OLLAMA_API_KEY", "ollama-test-key")

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value=None):
                kwargs = get_agent_llm_kwargs("custom_agent")

    assert kwargs["api_base"] == "https://ollama.com"
    assert kwargs["api_key"] == "ollama-test-key"
    assert kwargs["timeout"] == 600.0
    assert kwargs["request_timeout"] == 600.0


def test_normalize_ollama_api_base_for_litellm_strips_v1_suffix():
    from opalatex.config import normalize_ollama_api_base_for_litellm

    assert normalize_ollama_api_base_for_litellm(
        "ollama/gpt-oss:20b",
        "http://100.85.255.111:11434/v1",
    ) == "http://100.85.255.111:11434"
    assert normalize_ollama_api_base_for_litellm(
        "ollama_chat/gpt-oss:20b",
        "http://100.85.255.111:11434/v1/",
    ) == "http://100.85.255.111:11434"
    assert normalize_ollama_api_base_for_litellm(
        "openai/gpt-5.5",
        "http://example.test/v1",
    ) == "http://example.test/v1"


def test_resolve_model_for_thinking_requires_model_capability():
    from opalatex.config import resolve_model_for_thinking
    from unittest.mock import patch

    kwargs = {"think": True}
    with patch("opalatex.models_store.get_model", return_value={"supports_thinking": False}):
        model = resolve_model_for_thinking("ollama/mistral-large-3:675b-cloud", kwargs)

    assert model == "ollama/mistral-large-3:675b-cloud"
    assert "think" not in kwargs

    supported_kwargs = {"think": True}
    with patch("opalatex.models_store.get_model", return_value={"supports_thinking": True}):
        supported_model = resolve_model_for_thinking("ollama/gemma4:12b", supported_kwargs)

    assert supported_model == "ollama_chat/gemma4:12b"
    assert supported_kwargs["think"] is True


def test_internal_attachment_flags_are_not_sent_to_litellm():
    """Internal attachment flags must not leak into provider request kwargs."""
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "openai/gpt-5.5"
        model_params = {
            "force_vision": True,
            "pdf_truncate": True,
            "pdf_truncate_pct": 50,
            "temperature": 0.2,
        }
        project_path = "/fake/path"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value={"supports_thinking": False}):
                kwargs = get_agent_llm_kwargs("custom_agent")

    assert "temperature" not in kwargs
    assert kwargs["drop_params"] is True
    assert "force_vision" not in kwargs
    assert "pdf_truncate" not in kwargs
    assert "pdf_truncate_pct" not in kwargs


def test_openai_models_do_not_receive_local_only_litellm_kwargs():
    """OpenAI endpoints must only receive provider-supported request kwargs."""
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "openai/gpt-5.5"
        model_params = {
            "num_ctx": 8192,
            "top_k": 40,
            "min_p": 0.1,
            "repetition_penalty": 1.1,
            "think": False,
            "reasoning_effort": "none",
            "temperature": 0.2,
            "response_mode": "last",
            "max_heartbeats": 15,
            "unknown_param": "boom",
        }
        project_path = "/fake/path"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value={"supports_thinking": False}):
                kwargs = get_agent_llm_kwargs("custom_agent")

    assert "temperature" not in kwargs
    assert kwargs["drop_params"] is True
    assert "num_ctx" not in kwargs
    assert "top_k" not in kwargs
    assert "min_p" not in kwargs
    assert "repetition_penalty" not in kwargs
    assert "think" not in kwargs
    assert "reasoning_effort" not in kwargs
    assert "response_mode" not in kwargs
    assert "max_heartbeats" not in kwargs
    assert "unknown_param" not in kwargs


def test_openai_gpt55_chat_model_strips_reasoning_effort_to_avoid_responses_bridge():
    """GPT-5.4+ with tools + reasoning_effort makes LiteLLM use Responses API.

    AgenticBlocks uses Chat Completions-style tool loops, so the chat model id
    must not carry reasoning_effort. The explicit openai/responses/* model id is
    still allowed to opt into Responses behavior.
    """
    from opalatex.config import sanitize_litellm_kwargs_for_model

    chat_kwargs = sanitize_litellm_kwargs_for_model(
        "openai/gpt-5.5",
        {"reasoning_effort": "medium", "temperature": 0.2},
    )
    responses_kwargs = sanitize_litellm_kwargs_for_model(
        "openai/responses/gpt-5.5",
        {"reasoning_effort": "medium", "temperature": 0.2},
    )

    assert "reasoning_effort" not in chat_kwargs
    assert responses_kwargs["reasoning_effort"] == "medium"


def test_openai_gpt55_chat_model_strips_default_only_sampling_params():
    """GPT-5 chat models reject non-default sampling values such as temperature=0.7."""
    from opalatex.config import sanitize_litellm_kwargs_for_model

    kwargs = sanitize_litellm_kwargs_for_model(
        "openai/gpt-5.5",
        {
            "temperature": 0.7,
            "top_p": 0.9,
            "frequency_penalty": 0.3,
            "presence_penalty": 0.2,
            "max_tokens": 128,
        },
    )

    assert "temperature" not in kwargs
    assert "top_p" not in kwargs
    assert "frequency_penalty" not in kwargs
    assert "presence_penalty" not in kwargs
    assert kwargs["max_tokens"] == 128
    assert kwargs["drop_params"] is True


def test_gemini_models_drop_unknown_params_and_deprecated_sampling():
    """Gemini 3 direct calls drop deprecated sampling params and unknown fields."""
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "gemini/gemini-3.1-flash-lite"
        model_params = {
            "temperature": 0.2,
            "top_p": 0.9,
            "frequency_penalty": 0.3,
            "presence_penalty": 0.2,
            "num_ctx": 8192,
            "top_k": 40,
            "think": False,
            "unknown_param": "boom",
        }
        project_path = "/fake/path"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            kwargs = get_agent_llm_kwargs("custom_agent")

    assert "temperature" not in kwargs
    assert "top_p" not in kwargs
    assert kwargs["frequency_penalty"] == 0.3
    assert kwargs["presence_penalty"] == 0.2
    assert kwargs["drop_params"] is True
    assert "num_ctx" not in kwargs
    assert "top_k" not in kwargs
    assert "think" not in kwargs
    assert "unknown_param" not in kwargs


def test_ollama_models_keep_local_only_litellm_kwargs_except_unsupported_think():
    """Ollama keeps local tuning params, but think is capability-gated."""
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "ollama/gemma4:12b"
        model_params = {
            "num_ctx": 8192,
            "top_k": 40,
            "min_p": 0.1,
            "repetition_penalty": 1.1,
            "think": False,
            "temperature": 0.2,
            "unknown_param": "boom",
        }
        project_path = "/fake/path"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value={"supports_thinking": False}):
                kwargs = get_agent_llm_kwargs("custom_agent")

    assert kwargs["temperature"] == 0.2
    assert kwargs["num_ctx"] == 8192
    assert kwargs["top_k"] == 40
    assert kwargs["min_p"] == 0.1
    assert kwargs["repetition_penalty"] == 1.1
    assert "think" not in kwargs
    assert kwargs.get("drop_params") is True
    assert "unknown_param" not in kwargs

def test_project_ollama_api_base_is_used_when_model_store_has_no_entry():
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "ollama/gpt-oss:20b"
        model_params = {}
        project_path = "/fake/path"
        api_base = "http://100.85.255.111:11434/v1"
        api_key = "remote-key"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value=None):
                kwargs = get_agent_llm_kwargs("custom_agent")

    assert kwargs["api_base"] == "http://100.85.255.111:11434"
    assert kwargs["api_key"] == "remote-key"


def test_worker_ollama_api_base_uses_worker_setting_first():
    from opalatex.config import get_agent_llm_kwargs
    from unittest.mock import patch

    class FakeSession:
        model = "ollama/main:latest"
        worker_model = "ollama/gpt-oss:20b"
        model_params = {}
        worker_model_params = {}
        project_path = "/fake/path"
        api_base = "http://main-host:11434/v1"
        api_key = "main-key"
        worker_api_base = "http://worker-host:11434/v1"
        worker_api_key = "worker-key"

    with patch("opalatex.tools._PROJECT_SESSION", FakeSession()):
        with patch("opalatex.ui_settings.load_ui_settings", return_value={}):
            with patch("opalatex.models_store.get_model", return_value=None):
                kwargs = get_agent_llm_kwargs("worker")

    assert kwargs["api_base"] == "http://worker-host:11434"
    assert kwargs["api_key"] == "worker-key"
