"""Tests for automatic and on-demand chat titling.

Covers:
- ProjectStore persistence, migration, atomic claiming (automatic and forced),
  manual-rename race protection, empty-chat preservation, and tutorial chat
  exclusion for automatic renaming.
- ``opalatex.chat_title`` transcript formatting, title cleaning, ephemeral
  ``LLMAgentBlock`` invocation (plain text, low reasoning effort, no
  ``user_prompt_prefix``), and end-to-end ``auto_title_chat`` (both automatic
  and ``force=True``).
- HTTP endpoints ``/api/chat/create``, ``/api/chat/list``, ``/api/chat/rename``
  and ``/api/chat/auto-title`` (automatic and ``force=True``).
- CLI ``run_turn`` auto-titling right after the user's first question and
  ``/chat auto-rename`` on demand.
- Cloud sync keeping ``auto_title_pending`` machine-local.
"""

from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from opalatex.chat_title import (
    CHAT_TITLE_REASONING_EFFORT,
    auto_title_chat,
    build_chat_title_system_prompt,
    clean_generated_title,
    format_conversation_for_title,
    generate_chat_title,
)
from opalatex.cloud.chats import export_project, merge_into_database
from opalatex.ide_server import AsyncHTTPServer
from opalatex.project import ProjectStore, tutorial_chat_id


def _make_project(tmp_path, name="myproj"):
    db_path = str(tmp_path / "projects.db")
    store = ProjectStore(db_path=db_path)
    proj_dir = tmp_path / name
    proj_dir.mkdir(parents=True, exist_ok=True)
    store.create(
        name=name,
        mode="plan",
        model="fake/model",
        project_name="My Project",
        project_path=str(proj_dir),
    )
    return db_path, store


@pytest.fixture(autouse=True)
def _isolate_models_db(tmp_path, monkeypatch):
    """Keep tests off the user's real ~/.opalatex/sessions.db."""
    monkeypatch.setattr("opalatex.models_store._resolve_db_path", lambda: tmp_path / "models.db")


def _stub_llm_agent(monkeypatch, response_or_fn):
    """Replace AgenticBlocks LLMAgentBlock with a test double."""
    import agenticblocks.blocks.llm.agent as agent_mod

    captured = {"calls": 0}

    class FakeAgent:
        def __init__(self, **kwargs):
            captured["init"] = kwargs

        async def run(self, agent_input):
            captured["calls"] += 1
            captured["prompt"] = agent_input.prompt
            if callable(response_or_fn):
                res = response_or_fn(agent_input.prompt)
                if isinstance(res, Exception):
                    raise res
                return SimpleNamespace(response=res, structured_output=None)
            if isinstance(response_or_fn, Exception):
                raise response_or_fn
            return SimpleNamespace(response=response_or_fn, structured_output=None)

    monkeypatch.setattr(agent_mod, "LLMAgentBlock", FakeAgent)
    monkeypatch.setattr("opalatex.litellm_compat.wrap_agent_litellm_compat", lambda agent: agent)
    return captured


def _server_with_capture():
    server = AsyncHTTPServer()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8")), content_type))

    server.send_response = mock_send_response
    return server, responses


# ─── ProjectStore persistence & invariants ────────────────────────────────────


def test_legacy_db_migration_defaults_existing_chats_to_not_pending(tmp_path):
    """Chats created before this feature must never be auto-renamed unexpectedly."""
    db_path = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE projects (
            name TEXT PRIMARY KEY,
            mode TEXT NOT NULL DEFAULT 'plan',
            model TEXT NOT NULL DEFAULT '',
            project_name TEXT NOT NULL DEFAULT '',
            project_path TEXT NOT NULL DEFAULT '',
            skills TEXT NOT NULL DEFAULT '["opalatex"]',
            description TEXT NOT NULL DEFAULT '',
            core_memory TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE project_chats (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            core_memory TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE project_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL
        );
        INSERT INTO projects (name, model, project_path) VALUES ('legacy', 'fake/model', '/tmp');
        INSERT INTO project_chats (id, project, name, created_at)
        VALUES ('old-chat', 'legacy', 'New Chat', '2026-01-01T00:00:00+00:00');
        """
    )
    conn.commit()
    conn.close()

    store = ProjectStore(db_path=db_path)
    assert store.is_auto_title_pending("legacy", "old-chat") is False
    assert store.claim_auto_title("legacy", "old-chat") == (None, "not_eligible")


def test_store_auto_title_lifecycle_and_forced_claim(tmp_path):
    _, store = _make_project(tmp_path)

    # Default-named chat starts pending; custom-named chat does not.
    store.create_chat("myproj", "c-default", "Chat 1", auto_title_pending=True)
    store.create_chat("myproj", "c-custom", "My Custom Title", auto_title_pending=False)
    tut_id = tutorial_chat_id("myproj")
    store.create_chat("myproj", tut_id, "Tutorial", auto_title_pending=True)

    assert store.is_auto_title_pending("myproj", "c-default") is True
    assert store.is_auto_title_pending("myproj", "c-custom") is False
    assert store.is_auto_title_pending("myproj", tut_id) is False
    assert store.list_chat_auto_title_pending("myproj") == {"c-default": True}

    # Empty chat does not consume auto_title_pending (neither automatic nor forced).
    assert store.claim_auto_title("myproj", "c-default") == (None, "no_messages")
    assert store.claim_auto_title("myproj", "c-default", force=True) == (None, "no_messages")
    assert store.is_auto_title_pending("myproj", "c-default") is True

    # Once a user message exists, automatic claim succeeds exactly once.
    proj = store.load("myproj", chat_id="c-default")
    store.append_message(proj, "user", "How do I configure BibLaTeX?")
    assert store.claim_auto_title("myproj", "c-default") == ("Chat 1", "claimed")
    assert store.is_auto_title_pending("myproj", "c-default") is False
    assert store.claim_auto_title("myproj", "c-default") == (None, "not_eligible")

    assert store.apply_auto_title("myproj", "c-default", "Chat 1", "BibLaTeX Configuration") is True
    loaded = store.load("myproj", chat_id="c-default")
    chat_names = {c["id"]: c["name"] for c in loaded.chats}
    assert chat_names["c-default"] == "BibLaTeX Configuration"

    # Forced claim works on custom-named or already-renamed chats with messages.
    proj_custom = store.load("myproj", chat_id="c-custom")
    store.append_message(proj_custom, "user", "Explain Beamer overlays.")
    assert store.claim_auto_title("myproj", "c-custom", force=False) == (None, "not_eligible")
    assert store.claim_auto_title("myproj", "c-custom", force=True) == ("My Custom Title", "claimed")
    assert store.apply_auto_title("myproj", "c-custom", "My Custom Title", "Beamer Overlays") is True


def test_manual_rename_clears_pending_and_blocks_in_flight_overwrite(tmp_path):
    _, store = _make_project(tmp_path)
    store.create_chat("myproj", "c1", "Chat 1", auto_title_pending=True)
    proj = store.load("myproj", chat_id="c1")
    store.append_message(proj, "user", "Explain quantum entanglement.")

    # Manual rename before auto-title cancels pending flag.
    store.rename_chat("myproj", "c1", "Physics Notes")
    assert store.is_auto_title_pending("myproj", "c1") is False
    assert store.claim_auto_title("myproj", "c1") == (None, "not_eligible")

    # Manual rename while an auto-title call is already in flight wins over late apply.
    store.create_chat("myproj", "c2", "Chat 2", auto_title_pending=True)
    proj2 = store.load("myproj", chat_id="c2")
    store.append_message(proj2, "user", "Fix Makefile target.")
    original, reason = store.claim_auto_title("myproj", "c2")
    assert (original, reason) == ("Chat 2", "claimed")

    store.rename_chat("myproj", "c2", "User Chosen Name")
    assert store.apply_auto_title("myproj", "c2", original, "Makefile Target Fix") is False
    loaded = store.load("myproj", chat_id="c2")
    chat_names = {c["id"]: c["name"] for c in loaded.chats}
    assert chat_names["c2"] == "User Chosen Name"


# ─── Formatting, cleaning, and LLM invocation ─────────────────────────────────


def test_format_conversation_for_title_filters_and_bounds_long_chats():
    messages = [
        {"role": "system", "content": "internal"},
        {"role": "user", "content": "Help me debug my Beamer slides layout."},
        {"role": "assistant", "content": "Sure, let's inspect the frame margins."},
        {"role": "user", "content": "Also adjust the bibliography font size."},
    ]
    text = format_conversation_for_title(messages)
    assert "internal" not in text
    assert "User: Help me debug my Beamer slides layout." in text
    assert "Assistant: Sure, let's inspect the frame margins." in text

    long_msgs = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"Turn {i}: " + ("word " * 80)}
        for i in range(20)
    ]
    bounded = format_conversation_for_title(long_msgs, max_chars=900, max_message_chars=150)
    assert len(bounded) <= 900
    assert "Turn 0:" in bounded
    assert "Turn 19:" in bounded


def test_clean_generated_title_strips_markup_reasoning_and_clamps_length():
    assert clean_generated_title("<think>thinking...</think>\"Configuração do BibLaTeX.\"") == "Configuração do BibLaTeX"
    assert clean_generated_title("```text\nTitle: Debugging SQLite Migrations.\nExtra line\n```") == "Debugging SQLite Migrations"
    assert clean_generated_title("# **Beamer Slide Margins**") == "Beamer Slide Margins"

    long_title = "A very long conversation title about configuring multiple LaTeX packages and custom Beamer themes in detail"
    clamped = clean_generated_title(long_title, max_chars=50)
    assert len(clamped) <= 50
    assert not clamped.endswith(".")

    with pytest.raises(ValueError, match="reasoning only"):
        clean_generated_title("<think>just pondering</think>")

    with pytest.raises(ValueError, match="empty"):
        clean_generated_title("   \"\"   ")


@pytest.mark.asyncio
async def test_generate_chat_title_uses_plain_text_agent_without_prompt_prefix(monkeypatch):
    captured = _stub_llm_agent(monkeypatch, "Debugging LaTeX Table Alignment")
    monkeypatch.setattr(
        "opalatex.config.get_agent_llm_kwargs",
        lambda role, model_override=None, reasoning_effort_override=None: {
            "reasoning_effort": reasoning_effort_override,
        },
    )
    monkeypatch.setattr("opalatex.config.resolve_model_route", lambda model, kwargs: model)

    title = await generate_chat_title(
        [{"role": "user", "content": "My LaTeX table columns are misaligned."}],
        model="openai/gpt-4o",
    )
    assert title == "Debugging LaTeX Table Alignment"
    assert captured["calls"] == 1
    assert "user_prompt_prefix" not in captured["init"]
    assert "response_schema" not in captured["init"]
    assert captured["init"]["model_kwargs"]["reasoning_effort"] == CHAT_TITLE_REASONING_EFFORT
    assert "same language" in build_chat_title_system_prompt()


@pytest.mark.asyncio
async def test_auto_title_chat_automatic_once_and_forced_on_demand(tmp_path, monkeypatch):
    _, store = _make_project(tmp_path)
    store.create_chat("myproj", "c1", "Chat 1", auto_title_pending=True)
    titles = iter(["Tabelas Longas no LaTeX", "Tabelas e Bibliografia no LaTeX"])
    captured = _stub_llm_agent(monkeypatch, lambda _prompt: next(titles))
    monkeypatch.setattr("opalatex.config.resolve_model_route", lambda model, kwargs: model)

    # Empty chat -> skipped, still pending, LLM not called.
    first_empty = await auto_title_chat(store, "myproj", "c1")
    assert first_empty["renamed"] is False
    assert first_empty["reason"] == "no_messages"
    assert first_empty["auto_title_pending"] is True
    assert captured["calls"] == 0

    # After first user question -> automatic rename runs once.
    proj = store.load("myproj", chat_id="c1")
    store.append_message(proj, "user", "Como alinhar tabelas longas no LaTeX?")

    first_auto = await auto_title_chat(store, "myproj", "c1")
    assert first_auto == {
        "renamed": True,
        "reason": "renamed",
        "chat_id": "c1",
        "name": "Tabelas Longas no LaTeX",
        "auto_title_pending": False,
    }
    assert captured["calls"] == 1

    # Second automatic trigger -> skipped.
    second_auto = await auto_title_chat(store, "myproj", "c1")
    assert second_auto["renamed"] is False
    assert second_auto["reason"] == "not_eligible"
    assert captured["calls"] == 1

    # Conversation evolves, user clicks "Auto-rename" (force=True) -> regenerates title.
    proj = store.load("myproj", chat_id="c1")
    store.append_message(proj, "assistant", "Use o pacote longtable.")
    store.append_message(proj, "user", "Agora configure a bibliografia ABNT também.")

    forced = await auto_title_chat(store, "myproj", "c1", force=True)
    assert forced == {
        "renamed": True,
        "reason": "renamed",
        "chat_id": "c1",
        "name": "Tabelas e Bibliografia no LaTeX",
        "auto_title_pending": False,
    }
    assert captured["calls"] == 2
    assert "bibliografia ABNT" in captured["prompt"]


# ─── HTTP API endpoints ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_api_create_list_auto_and_forced_rename(tmp_path, monkeypatch):
    db_path, store = _make_project(tmp_path)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    titles = iter(["TikZ Flowchart Diagram", "Custom Topic Summary"])
    captured = _stub_llm_agent(monkeypatch, lambda _prompt: next(titles))
    monkeypatch.setattr("opalatex.config.resolve_model_route", lambda model, kwargs: model)

    server, responses = _server_with_capture()
    writer = AsyncMock()

    # 1. Create a default-named chat and a custom-named chat.
    await server.route_api(
        "POST", "/api/chat/create", {}, {},
        json.dumps({"project_name": "myproj", "chat_name": "Chat 1", "auto_title_pending": True}).encode(),
        writer,
    )
    status, default_chat, _ = responses.pop()
    assert status == 200
    assert default_chat["auto_title_pending"] is True

    await server.route_api(
        "POST", "/api/chat/create", {}, {},
        json.dumps({"project_name": "myproj", "chat_name": "Custom Name", "auto_title_pending": False}).encode(),
        writer,
    )
    status, custom_chat, _ = responses.pop()
    assert status == 200
    assert custom_chat["auto_title_pending"] is False

    # 2. /api/chat/list exposes auto_title_pending per chat.
    await server.route_api("GET", "/api/chat/list", {"project_name": ["myproj"]}, {}, b"", writer)
    status, list_body, _ = responses.pop()
    assert status == 200
    by_id = {c["id"]: c for c in list_body["chats"]}
    assert by_id[default_chat["id"]]["auto_title_pending"] is True
    assert by_id[custom_chat["id"]]["auto_title_pending"] is False

    # 3. After first user message, automatic call renames the default chat.
    proj = store.load("myproj", chat_id=default_chat["id"])
    store.append_message(proj, "user", "Draw a TikZ flowchart for my methodology.")
    await server.route_api(
        "POST", "/api/chat/auto-title", {}, {},
        json.dumps({"project_name": "myproj", "chat_id": default_chat["id"]}).encode(),
        writer,
    )
    status, body, _ = responses.pop()
    assert status == 200
    assert body["renamed"] is True
    assert body["name"] == "TikZ Flowchart Diagram"
    assert body["auto_title_pending"] is False
    assert captured["calls"] == 1

    # 4. Custom-named chat is NOT auto-renamed when force is False...
    proj_custom = store.load("myproj", chat_id=custom_chat["id"])
    store.append_message(proj_custom, "user", "Summarize the project architecture.")
    await server.route_api(
        "POST", "/api/chat/auto-title", {}, {},
        json.dumps({"project_name": "myproj", "chat_id": custom_chat["id"], "force": False}).encode(),
        writer,
    )
    status, body, _ = responses.pop()
    assert status == 200
    assert body["renamed"] is False
    assert body["reason"] == "not_eligible"
    assert captured["calls"] == 1

    # 5. ...but clicking "Auto-rename" (force=True) renames it from its conversation.
    await server.route_api(
        "POST", "/api/chat/auto-title", {}, {},
        json.dumps({"project_name": "myproj", "chat_id": custom_chat["id"], "force": True}).encode(),
        writer,
    )
    status, body, _ = responses.pop()
    assert status == 200
    assert body["renamed"] is True
    assert body["name"] == "Custom Topic Summary"
    assert captured["calls"] == 2


@pytest.mark.asyncio
async def test_chat_auto_title_endpoint_validation_and_error_handling(tmp_path, monkeypatch):
    db_path, store = _make_project(tmp_path)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    server, responses = _server_with_capture()
    writer = AsyncMock()

    await server.route_api("POST", "/api/chat/auto-title", {}, {}, b"{}", writer)
    assert responses.pop()[0] == 400

    await server.route_api(
        "POST", "/api/chat/auto-title", {}, {},
        json.dumps({"project_name": "ghost", "chat_id": "c1"}).encode(),
        writer,
    )
    assert responses.pop()[0] == 404

    store.create_chat("myproj", "c-err", "Chat 1", auto_title_pending=True)
    proj = store.load("myproj", chat_id="c-err")
    store.append_message(proj, "user", "Hello")
    _stub_llm_agent(monkeypatch, RuntimeError("provider offline"))
    monkeypatch.setattr("opalatex.config.resolve_model_route", lambda model, kwargs: model)

    await server.route_api(
        "POST", "/api/chat/auto-title", {}, {},
        json.dumps({"project_name": "myproj", "chat_id": "c-err"}).encode(),
        writer,
    )
    status, body, _ = responses.pop()
    assert status == 200
    assert body["renamed"] is False
    assert body["reason"] == "error"
    assert "provider offline" in body["error"]
    assert store.is_auto_title_pending("myproj", "c-err") is False


# ─── CLI integration ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_run_turn_auto_titles_first_question_and_chat_auto_rename(tmp_path, monkeypatch):
    db_path, store = _make_project(tmp_path)
    proj = store.load("myproj")

    titles = iter(["Parser Unit Tests", "Parser and CLI Tests"])
    _stub_llm_agent(monkeypatch, lambda _prompt: next(titles))
    monkeypatch.setattr("opalatex.config.resolve_model_route", lambda model, kwargs: model)

    async def fake_handle_run(data):
        loaded = store.load(data["project_name"], chat_id=data["chat_id"])
        store.append_message(loaded, "user", data["prompt"])
        store.append_message(loaded, "assistant", "Done.")

    monkeypatch.setattr("opalatex.agent_stdin.handle_run", fake_handle_run)

    from opalatex.cli import REPLState, run_turn
    from opalatex.cli_commands import cmd_chat

    state = REPLState(proj, store)
    ok = await run_turn(state, "Write unit tests for parser.py", db_path=db_path)
    assert ok is True
    chat_id = state.project.current_chat_id
    names = {c["id"]: c["name"] for c in state.project.chats}
    assert names[chat_id] == "Parser Unit Tests"
    assert store.is_auto_title_pending("myproj", chat_id) is False

    # On-demand /chat auto-rename regenerates the title even after automatic rename.
    store.append_message(state.project, "user", "Also cover the CLI commands.")
    res = await cmd_chat(state, ["auto-rename"])
    assert res == "continue"
    names = {c["id"]: c["name"] for c in state.project.chats}
    assert names[chat_id] == "Parser and CLI Tests"


# ─── Cloud sync isolation ─────────────────────────────────────────────────────


def test_cloud_export_keeps_auto_title_pending_machine_local(tmp_path):
    db_path, store = _make_project(tmp_path)
    store.create_chat("myproj", "c1", "Chat 1", auto_title_pending=True)

    exported = export_project("myproj", db_path=db_path)
    assert len(exported["chats"]) == 1
    assert "auto_title_pending" not in exported["chats"][0]

    db_path2 = str(tmp_path / "target.db")
    store2 = ProjectStore(db_path=db_path2)
    store2.create(name="myproj", mode="plan", model="fake/model", project_path=str(tmp_path / "p2"))
    exported["chats"][0]["auto_title_pending"] = 1
    merge_into_database("myproj", exported, db_path=db_path2)
    assert store2.is_auto_title_pending("myproj", "c1") is False
