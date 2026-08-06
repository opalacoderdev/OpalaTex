import json
from unittest.mock import AsyncMock
import pytest

from opalatex.ide_server import AsyncHTTPServer, PromptEvolutionResult, clean_evolved_prompt


def test_clean_evolved_prompt():
    result = PromptEvolutionResult(
        evolved_prompt="  Explain self-attention in Transformers.  "
    )
    assert clean_evolved_prompt(result) == "Explain self-attention in Transformers."

    with pytest.raises(TypeError, match="validated structured result"):
        clean_evolved_prompt({"evolved_prompt": "plain dictionary"})

    with pytest.raises(ValueError, match="empty refined prompt"):
        clean_evolved_prompt(PromptEvolutionResult(evolved_prompt="   "))

    source_prompt = "Ensine-me sobre auto-atenção no transformer."
    with pytest.raises(ValueError, match="original prompt unchanged"):
        clean_evolved_prompt(
            PromptEvolutionResult(evolved_prompt=source_prompt),
            source_prompt=source_prompt,
        )
    with pytest.raises(ValueError, match="internal task wrapper"):
        clean_evolved_prompt(
            PromptEvolutionResult(evolved_prompt=f"Refine this user prompt: {source_prompt}"),
            source_prompt=source_prompt,
        )
    with pytest.raises(ValueError, match="internal instructions"):
        clean_evolved_prompt(
            PromptEvolutionResult(
                evolved_prompt=(
                    "Refine this user prompt while preserving its language and intent. "
                    "Return only a JSON object that conforms to the provided response schema."
                )
            ),
            source_prompt=source_prompt,
        )

@pytest.mark.asyncio
async def test_prompt_evolution_settings_endpoints(tmp_path, monkeypatch):
    settings_file = tmp_path / "ui_settings.json"
    monkeypatch.setattr("opalatex.ui_settings._SETTINGS_PATH", settings_file)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    # GET default settings
    await server.route_api("GET", "/api/settings/prompt-evolution", {}, {}, b"", writer)
    assert responses[-1] == (200, {"prompt_evolution_iterations": 1, "prompt_evolution_max_tokens": 4096}, "application/json")

    # POST new iterations setting = 4
    await server.route_api(
        "POST",
        "/api/settings/prompt-evolution",
        {},
        {},
        json.dumps({"prompt_evolution_iterations": 4, "prompt_evolution_max_tokens": 6000}).encode("utf-8"),
        writer,
    )
    assert responses[-1] == (200, {"success": True, "prompt_evolution_iterations": 4, "prompt_evolution_max_tokens": 6000}, "application/json")

    # GET updated settings
    await server.route_api("GET", "/api/settings/prompt-evolution", {}, {}, b"", writer)
    assert responses[-1] == (200, {"prompt_evolution_iterations": 4, "prompt_evolution_max_tokens": 6000}, "application/json")

    # POST invalid/zero iteration setting clamps to 1
    await server.route_api(
        "POST",
        "/api/settings/prompt-evolution",
        {},
        {},
        json.dumps({"prompt_evolution_iterations": -2, "prompt_evolution_max_tokens": -2}).encode("utf-8"),
        writer,
    )
    assert responses[-1] == (200, {"success": True, "prompt_evolution_iterations": 1, "prompt_evolution_max_tokens": 1}, "application/json")


@pytest.mark.asyncio
async def test_evolve_prompt_endpoint(tmp_path, monkeypatch):
    settings_file = tmp_path / "ui_settings.json"
    monkeypatch.setattr("opalatex.ui_settings._SETTINGS_PATH", settings_file)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    # Empty prompt returns 400
    await server.route_api(
        "POST",
        "/api/chat/evolve-prompt",
        {},
        {},
        json.dumps({"prompt": "   "}).encode("utf-8"),
        writer,
    )
    assert responses[-1][0] == 400

    # Mock _execute_prompt_evolution
    endpoint_call = {}

    async def mock_execute(prompt, iterations=1, model=None, max_tokens=4096):
        endpoint_call["model"] = model
        endpoint_call["max_tokens"] = max_tokens
        return f"Evolved {iterations}x: {prompt}"

    monkeypatch.setattr("opalatex.ide_server._execute_prompt_evolution", mock_execute)

    await server.route_api(
        "POST",
        "/api/chat/evolve-prompt",
        {},
        {},
        json.dumps({"prompt": "Write a report on renewable energy", "iterations": 2, "model": "test-provider/selected-chat-model"}).encode("utf-8"),
        writer,
    )
    assert responses[-1] == (
        200,
        {"success": True, "prompt": "Evolved 2x: Write a report on renewable energy"},
        "application/json",
    )
    assert endpoint_call["model"] == "test-provider/selected-chat-model"
    assert endpoint_call["max_tokens"] == 4096


@pytest.mark.asyncio
async def test_execute_prompt_evolution_invokes_agent(monkeypatch):
    from opalatex.ide_server import _execute_prompt_evolution
    from unittest.mock import MagicMock

    mock_agent_instance = MagicMock()
    mock_agent_instance.run = AsyncMock(return_value=MagicMock(structured_output=PromptEvolutionResult(evolved_prompt="Detailed Evolved Prompt")))

    agent_kwargs = {}

    def mock_agent_class(*args, **kwargs):
        agent_kwargs.update(kwargs)
        return mock_agent_instance

    monkeypatch.setattr("agenticblocks.blocks.llm.agent.LLMAgentBlock", mock_agent_class)
    monkeypatch.setattr("opalatex.litellm_compat.wrap_agent_litellm_compat", lambda a: a)

    selected_model = "test-provider/prompt-model"
    captured = {}

    def mock_get_llm_kwargs(agent_name, model_override=None):
        captured["agent_name"] = agent_name
        captured["model_override"] = model_override
        return {"think": True}

    monkeypatch.setattr("opalatex.config.get_agent_llm_kwargs", mock_get_llm_kwargs)

    result = await _execute_prompt_evolution(
        "Short prompt",
        iterations=1,
        model=selected_model,
        max_tokens=4096,
    )
    assert result == "Detailed Evolved Prompt"
    assert agent_kwargs["model"] == selected_model
    assert agent_kwargs["model_kwargs"]["think"] is True
    assert agent_kwargs["model_kwargs"]["max_tokens"] == 4096
    assert agent_kwargs["response_schema"] is PromptEvolutionResult
    run_input = mock_agent_instance.run.call_args.args[0]
    assert run_input.prompt == "Short prompt"
    assert "Refine this user prompt" not in run_input.prompt
    assert captured == {
        "agent_name": "orchestrator",
        "model_override": selected_model,
    }
