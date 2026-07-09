import json
from unittest.mock import AsyncMock

import pytest

from opalatex.ide_server import AsyncHTTPServer
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
