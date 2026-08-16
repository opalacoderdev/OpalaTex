"""Pre-multi-chat rows must end up in the project's real main chat.

``chat_id`` was added to ``project_history`` and ``project_activity`` with
``DEFAULT 'main'`` and never backfilled. Since no chat is stored under that id,
every conversation written before multi-chat support became unreachable: the
read paths all scope by a real chat id. The migration moves those rows once.
"""
import sqlite3

import pytest

from opalatex.project import (
    LEGACY_MAIN_CHAT_ID,
    MAIN_CHAT_NAME,
    ProjectStore,
    main_chat_id,
)


def _legacy_rows(db_path, table, project):
    with sqlite3.connect(db_path) as conn:
        return conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE project = ? AND chat_id = ?",
            (project, LEGACY_MAIN_CHAT_ID),
        ).fetchone()[0]


def _write_legacy_rows(db_path, project, *, messages=(), activity=(), client_message_ids=None):
    """Insert rows exactly as the pre-multi-chat schema left them."""
    client_message_ids = client_message_ids or {}
    with sqlite3.connect(db_path) as conn:
        for content in messages:
            conn.execute(
                "INSERT INTO project_history (project, chat_id, timestamp, role, content, client_message_id)"
                " VALUES (?,?,?,?,?,?)",
                (project, LEGACY_MAIN_CHAT_ID, "2024-01-01T00:00:00Z", "user", content,
                 client_message_ids.get(content, "")),
            )
        for content in activity:
            conn.execute(
                "INSERT INTO project_activity (project, chat_id, timestamp, event, agent, content)"
                " VALUES (?,?,?,?,?,?)",
                (project, LEGACY_MAIN_CHAT_ID, "2024-01-01T00:00:00Z", "thought", "orchestrator", content),
            )


@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "projects.db")


def test_legacy_history_is_reattached_to_the_main_chat(db_path):
    store = ProjectStore(db_path=db_path)
    store.create("myproj", "chat", "gpt-4")
    _write_legacy_rows(db_path, "myproj", messages=["old question", "old answer"],
                       activity=["old thought"])

    # A fresh store re-runs the schema init, which carries the migration.
    store = ProjectStore(db_path=db_path)
    loaded = store.load("myproj")

    assert [m["content"] for m in loaded.history] == ["old question", "old answer"]
    assert [a["content"] for a in store.list_activity("myproj", main_chat_id("myproj"))] == ["old thought"]
    assert _legacy_rows(db_path, "project_history", "myproj") == 0
    assert _legacy_rows(db_path, "project_activity", "myproj") == 0


def test_migration_is_idempotent_and_does_not_duplicate(db_path):
    store = ProjectStore(db_path=db_path)
    store.create("myproj", "chat", "gpt-4")
    _write_legacy_rows(db_path, "myproj", messages=["old question"])

    for _ in range(3):
        store = ProjectStore(db_path=db_path)

    assert [m["content"] for m in store.load("myproj").history] == ["old question"]


def test_legacy_rows_do_not_leak_into_other_chats(db_path):
    store = ProjectStore(db_path=db_path)
    store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", "second", "Second Chat")
    second = store.load("myproj", chat_id="second")
    store.append_message(second, "user", "message in second")
    _write_legacy_rows(db_path, "myproj", messages=["legacy message"])

    store = ProjectStore(db_path=db_path)

    assert [m["content"] for m in store.load("myproj").history] == ["legacy message"]
    assert [m["content"] for m in store.load("myproj", chat_id="second").history] == ["message in second"]


def test_each_project_keeps_its_own_legacy_rows(db_path):
    store = ProjectStore(db_path=db_path)
    store.create("alpha", "chat", "gpt-4")
    store.create("beta", "chat", "gpt-4")
    _write_legacy_rows(db_path, "alpha", messages=["alpha history"])
    _write_legacy_rows(db_path, "beta", messages=["beta history"])

    store = ProjectStore(db_path=db_path)

    assert [m["content"] for m in store.load("alpha").history] == ["alpha history"]
    assert [m["content"] for m in store.load("beta").history] == ["beta history"]


def test_a_project_owning_a_chat_named_main_is_left_untouched(db_path):
    """Not a legacy project: those rows belong to a chat that really exists."""
    store = ProjectStore(db_path=db_path)
    store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", LEGACY_MAIN_CHAT_ID, "Literally Main")
    real_main = store.load("myproj", chat_id=LEGACY_MAIN_CHAT_ID)
    store.append_message(real_main, "user", "belongs to the 'main' chat")

    store = ProjectStore(db_path=db_path)

    assert [m["content"] for m in store.load("myproj", chat_id=LEGACY_MAIN_CHAT_ID).history] == [
        "belongs to the 'main' chat"
    ]
    assert store.load("myproj").history == []


def test_main_chat_is_recreated_when_a_legacy_project_lost_it(db_path):
    """Older builds could delete the main chat: its delete guard never matched."""
    store = ProjectStore(db_path=db_path)
    store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", "second", "Second Chat")
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "DELETE FROM project_chats WHERE project = ? AND id = ?",
            ("myproj", main_chat_id("myproj")),
        )
    _write_legacy_rows(db_path, "myproj", messages=["orphaned history"])

    store = ProjectStore(db_path=db_path)
    loaded = store.load("myproj")

    assert loaded.current_chat_id == main_chat_id("myproj")
    assert [m["content"] for m in loaded.history] == ["orphaned history"]
    # Restored with the project's own creation time, so it still sorts first.
    assert [c["id"] for c in loaded.chats] == [main_chat_id("myproj"), "second"]
    assert loaded.chats[0]["name"] == MAIN_CHAT_NAME


def test_a_colliding_client_message_id_does_not_abort_the_move(db_path):
    """The unique index is per (project, chat, client_message_id).

    A legacy row reusing an id already present in the main chat would abort the
    UPDATE; the message must survive, only its send-dedup marker is dropped.
    """
    store = ProjectStore(db_path=db_path)
    project = store.create("myproj", "chat", "gpt-4")
    store.append_message(project, "user", "current message", client_message_id="cid-1")
    _write_legacy_rows(db_path, "myproj", messages=["legacy message"],
                       client_message_ids={"legacy message": "cid-1"})

    store = ProjectStore(db_path=db_path)
    loaded = store.load("myproj")

    assert sorted(m["content"] for m in loaded.history) == ["current message", "legacy message"]
    assert _legacy_rows(db_path, "project_history", "myproj") == 0


def test_projects_without_legacy_rows_are_unchanged(db_path):
    store = ProjectStore(db_path=db_path)
    project = store.create("myproj", "chat", "gpt-4")
    store.append_message(project, "user", "modern message", client_message_id="cid-1")

    store = ProjectStore(db_path=db_path)
    loaded = store.load("myproj")

    assert [m["content"] for m in loaded.history] == ["modern message"]
    assert [m["client_message_id"] for m in loaded.history] == ["cid-1"]
