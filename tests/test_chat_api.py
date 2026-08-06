import json
from unittest.mock import AsyncMock

import pytest

from opalatex.ide_server import AsyncHTTPServer, _ollama_tags_url_for_model_info
from opalatex.project import ProjectStore


@pytest.mark.asyncio
async def test_chat_truncate_endpoint_returns_deleted_ids(tmp_path, monkeypatch):
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    project = store.create(
        name="myproj",
        mode="plan",
        model="fake/model",
        project_name="My Project",
        project_path=str(tmp_path / "project"),
    )
    first_id = store.append_message(project, "user", "first")
    reply_id = store.append_message(project, "assistant", "first reply")
    second_id = store.append_message(project, "user", "second")
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    await server.route_api(
        "POST",
        "/api/chat/truncate",
        {},
        {},
        json.dumps({
            "project_name": "myproj",
            "chat_id": project.current_chat_id,
            "from_index": 1,
        }).encode("utf-8"),
        writer,
    )

    assert responses == [
        (
            200,
            {"status": "ok", "deleted_ids": [reply_id, second_id]},
            "application/json",
        )
    ]
    loaded = store.load("myproj", chat_id=project.current_chat_id)
    assert [m["id"] for m in loaded.history] == [first_id]

@pytest.mark.asyncio
async def test_clear_all_chats_endpoint_resets_project_chats(tmp_path, monkeypatch):
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    project = store.create(
        name="myproj",
        mode="plan",
        model="fake/model",
        project_name="My Project",
        project_path=str(tmp_path / "project"),
    )
    store.append_message(project, "user", "main message")
    store.create_chat("myproj", "branch-1", "Branch")
    branch = store.load("myproj", chat_id="branch-1")
    store.append_message(branch, "user", "branch message")
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    await server.route_api(
        "POST",
        "/api/chat/clear-all",
        {},
        {},
        json.dumps({"project_name": "myproj"}).encode("utf-8"),
        writer,
    )

    assert responses == [
        (200, {"status": "ok", "chat": {"id": "main_myproj", "name": "Main Chat"}}, "application/json")
    ]
    loaded = store.load("myproj", chat_id="main_myproj")
    assert loaded.chats == [{"id": "main_myproj", "name": "Main Chat"}]
    assert loaded.history == []


@pytest.mark.asyncio
async def test_load_local_ollama_models_endpoint_returns_added_models(monkeypatch):
    added_models = [{
        "id": "ollama/new-model:latest",
        "provider": "ollama",
        "name": "new-model:latest",
        "api_key": "",
        "api_base": "http://localhost:11434/v1",
        "supports_thinking": False,
    }]
    monkeypatch.setattr(
        "opalatex.models_store.load_local_ollama_models",
        lambda: added_models,
    )
    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response
    await server.route_api(
        "POST",
        "/api/settings/models/load-local-ollama",
        {},
        {},
        b"{}",
        writer,
    )

    assert responses == [
        (200, {"models": added_models, "added_count": 1}, "application/json")
    ]


@pytest.mark.asyncio
async def test_load_local_ollama_models_endpoint_reports_missing_installation(monkeypatch):
    from opalatex.models_store import LocalOllamaNotInstalledError

    def raise_not_installed():
        raise LocalOllamaNotInstalledError()

    monkeypatch.setattr(
        "opalatex.models_store.load_local_ollama_models",
        raise_not_installed,
    )
    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response
    await server.route_api(
        "POST",
        "/api/settings/models/load-local-ollama",
        {},
        {},
        b"{}",
        writer,
    )

    assert responses == [
        (409, {"error": "ollama_not_installed"}, "application/json")
    ]
def test_ollama_model_info_uses_configured_remote_api_base():
    assert _ollama_tags_url_for_model_info(
        "ollama/gpt-oss:20b",
        "http://100.85.255.111:11434/v1",
    ) == "http://100.85.255.111:11434/api/tags"


def test_ollama_model_info_without_api_base_uses_localhost():
    assert _ollama_tags_url_for_model_info(
        "ollama/gemma4:26b",
        "",
    ) == "http://127.0.0.1:11434/api/tags"


@pytest.mark.asyncio
async def test_update_project_endpoint_updates_model(tmp_path, monkeypatch):
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    project = store.create(
        name="myproj",
        mode="plan",
        model="ollama/old-model",
        project_name="My Project",
        project_path=str(tmp_path / "project"),
    )
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response

    await server.route_api(
        "POST",
        "/api/opalatex/update-project",
        {},
        {},
        json.dumps({
            "project_name": "myproj",
            "model": "ollama/new-model:latest",
        }).encode("utf-8"),
        writer,
    )

    assert len(responses) == 1
    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["model"] == "ollama/new-model:latest"
    loaded = store.load("myproj")
    assert loaded.model == "ollama/new-model:latest"

