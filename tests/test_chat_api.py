import json
from unittest.mock import AsyncMock

import pytest

from opalatex.ide_server import AsyncHTTPServer, _ollama_tags_url_for_model_info
from opalatex.project import ProjectStore


@pytest.mark.asyncio
async def test_chat_truncate_endpoint_returns_superseded_ids(tmp_path, monkeypatch):
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
            "message_id": reply_id,
        }).encode("utf-8"),
        writer,
    )

    assert responses == [
        (
            200,
            {"status": "ok", "superseded_ids": [reply_id, second_id]},
            "application/json",
        )
    ]
    loaded = store.load("myproj", chat_id=project.current_chat_id)
    assert [m["id"] for m in loaded.history] == [first_id]


@pytest.mark.asyncio
async def test_chat_truncate_endpoint_rejects_request_without_stable_anchor(tmp_path, monkeypatch):
    """A positional index is not accepted: it cannot be mapped to stored rows safely."""
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    project = store.create(
        name="myproj",
        mode="plan",
        model="fake/model",
        project_name="My Project",
        project_path=str(tmp_path / "project"),
    )
    store.append_message(project, "user", "first")
    store.append_message(project, "assistant", "first reply")
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)

    server = AsyncHTTPServer()
    writer = AsyncMock()
    responses = []

    server.send_response = lambda _w, status, body, ctype="text/plain": responses.append(
        (status, json.loads(body.decode("utf-8")), ctype)
    )

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

    assert responses[0][0] == 400
    loaded = store.load("myproj", chat_id=project.current_chat_id)
    assert [m["content"] for m in loaded.history] == ["first", "first reply"]

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
    # Selecting a local Ollama model pre-fetches it; the test must not shell out
    # to `ollama pull`. See tests/test_ollama_model_prefetch.py for that path.
    pulled = []
    monkeypatch.setattr(
        "opalatex.ollama_manager.pull_model_in_background",
        lambda name, report=None: pulled.append(name) or True,
    )

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
    assert pulled == ["new-model:latest"]



def _api_harness(tmp_path, monkeypatch):
    """A server whose responses are collected instead of written to a socket."""
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)

    server = AsyncHTTPServer()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response
    return store, server, responses


@pytest.mark.asyncio
async def test_chat_history_rejects_an_unknown_chat_id(tmp_path, monkeypatch):
    """The stale-id case that made the selector and the transcript disagree.

    A client holding the sentinel ``"main"`` used to be answered with the most
    recently created chat, so the panel showed "Main Chat" over another chat's
    messages. It must fail instead, letting the client fall back to a real id.
    """
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    project = store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.append_message(project, "user", "message in main")
    store.create_chat("myproj", "second", "Second Chat")
    second = store.load("myproj", chat_id="second")
    store.append_message(second, "user", "message in second")

    await server.route_api(
        "GET",
        "/api/chat/history",
        {"project_name": ["myproj"], "chat_id": ["main"]},
        {},
        b"",
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 404
    assert "main" in data["error"]


@pytest.mark.asyncio
async def test_chat_history_without_chat_id_returns_the_main_chat(tmp_path, monkeypatch):
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    project = store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.append_message(project, "user", "message in main")
    store.create_chat("myproj", "second", "Second Chat")
    second = store.load("myproj", chat_id="second")
    store.append_message(second, "user", "message in second")

    await server.route_api(
        "GET",
        "/api/chat/history",
        {"project_name": ["myproj"]},
        {},
        b"",
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["chat_id"] == "main_myproj"
    assert [m["content"] for m in data["history"]] == ["message in main"]


@pytest.mark.asyncio
async def test_chat_history_names_the_chat_it_answered_for(tmp_path, monkeypatch):
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.create_chat("myproj", "second", "Second Chat")
    second = store.load("myproj", chat_id="second")
    store.append_message(second, "user", "message in second")

    await server.route_api(
        "GET",
        "/api/chat/history",
        {"project_name": ["myproj"], "chat_id": ["second"]},
        {},
        b"",
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["chat_id"] == "second"
    assert [m["content"] for m in data["history"]] == ["message in second"]


@pytest.mark.asyncio
async def test_chat_history_serves_the_occupancy_stored_for_that_chat(tmp_path, monkeypatch):
    """Reopening a chat must report its measured window, not an empty one.

    The in-process measurement holds a single scope, so running any other
    conversation (or restarting the server) leaves nothing for this chat. The
    endpoint then answered ``context_usage: null`` and the panel fell back to the
    character estimate, showing a full battery for a nearly full window.
    """
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.create_chat("myproj", "second", "Second Chat")
    store.save_chat_context_usage("myproj", "second", {
        "prompt_tokens": 34_500,
        "completion_tokens": 800,
        "total_tokens": 35_300,
        "context_window": 1_000_000,
    })

    # Another conversation owns the in-process slot, exactly as it would after
    # sending a message in a different chat.
    from opalatex import token_usage
    token_usage.set_context_scope(token_usage.context_scope_key("/elsewhere", "other"))
    token_usage.record_context_tokens(999)

    try:
        await server.route_api(
            "GET",
            "/api/chat/history",
            {"project_name": ["myproj"], "chat_id": ["second"]},
            {},
            b"",
            AsyncMock(),
        )
    finally:
        token_usage.set_context_scope("reset")

    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["context_usage"]["prompt_tokens"] == 34_500
    assert data["context_usage"]["context_window"] == 1_000_000


@pytest.mark.asyncio
async def test_chat_history_reports_no_occupancy_for_an_unmeasured_chat(tmp_path, monkeypatch):
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.create_chat("myproj", "second", "Second Chat")

    await server.route_api(
        "GET",
        "/api/chat/history",
        {"project_name": ["myproj"], "chat_id": ["second"]},
        {},
        b"",
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["context_usage"] is None


@pytest.mark.asyncio
async def test_chat_list_reports_the_real_main_chat_id(tmp_path, monkeypatch):
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))
    store.create_chat("myproj", "second", "Second Chat")

    await server.route_api(
        "GET",
        "/api/chat/list",
        {"project_name": ["myproj"]},
        {},
        b"",
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 200
    assert data["main_chat_id"] == "main_myproj"
    assert [c["id"] for c in data["chats"]] == ["main_myproj", "second"]


@pytest.mark.asyncio
async def test_chat_delete_refuses_the_main_chat(tmp_path, monkeypatch):
    store, server, responses = _api_harness(tmp_path, monkeypatch)
    store.create("myproj", "plan", "fake/model", project_path=str(tmp_path / "project"))

    await server.route_api(
        "POST",
        "/api/chat/delete",
        {},
        {},
        json.dumps({"project_name": "myproj", "chat_id": "main_myproj"}).encode("utf-8"),
        AsyncMock(),
    )

    status_code, data, _ = responses[0]
    assert status_code == 400
    assert "main chat" in data["error"]
    assert store.load("myproj").chats == [{"id": "main_myproj", "name": "Main Chat"}]
