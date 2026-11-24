"""Portable export/merge of a project's conversations.

The global `sessions.db` holds every project's chats, so it can never be
mirrored as a file. These tests cover the document that stands in for it.
"""

import json
import os
import sqlite3

import pytest

from opalatex.cloud import chats
from opalatex.project import ProjectStore


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "sessions.db")


@pytest.fixture
def project_dir(tmp_path):
    path = tmp_path / "project"
    path.mkdir()
    return str(path)


def make_project(db_path, name, project_path, messages=(), activity=()):
    store = ProjectStore(db_path)
    project = store.create(name, "plan", "ollama/test", project_name=name, project_path=project_path)
    store.create_chat(name, f"chat-{name}", "Chat")
    project = store.load(name)
    for role, content in messages:
        store.append_message(project, role, content)
    for event, content in activity:
        store.append_activity(name, project.current_chat_id, event, content=content)
    store.close_activity_connection()
    return store, project


def test_export_carries_only_the_named_project(db, project_dir, tmp_path):
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    make_project(db, "alpha", project_dir, messages=[("user", "alpha message")])
    make_project(db, "beta", str(other_dir), messages=[("user", "beta message")])

    payload = chats.export_project("alpha", db)

    contents = [m["content"] for m in payload["messages"]]
    assert "alpha message" in contents
    assert "beta message" not in contents


def test_export_is_deterministic(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one"), ("assistant", "two")])

    first = json.dumps(chats.export_project("alpha", db), sort_keys=True)
    second = json.dumps(chats.export_project("alpha", db), sort_keys=True)

    assert first == second


def test_write_export_reports_no_change_when_content_is_identical(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one")])
    payload = chats.export_project("alpha", db)

    assert chats.write_export(project_dir, payload) is True
    # Rewriting identical bytes would bump the mtime and make the scanner
    # re-upload the file on every pass.
    assert chats.write_export(project_dir, payload) is False


def test_export_never_carries_machine_local_paths(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one")])

    payload = chats.export_project("alpha", db)

    assert "project_path" not in payload.get("settings", {})
    assert "git_root_path" not in payload.get("settings", {})
    assert project_dir not in json.dumps(payload)


def test_merge_adds_messages_from_another_machine(db, project_dir, tmp_path):
    make_project(db, "alpha", project_dir, messages=[("user", "shared")])
    payload = chats.export_project("alpha", db)
    payload["messages"].append(
        {
            "chat_id": payload["messages"][0]["chat_id"],
            "timestamp": "2030-01-01T00:00:00+00:00",
            "role": "user",
            "content": "from the laptop",
            "client_message_id": "laptop-1",
            "attachments": "[]",
        }
    )

    stats = chats.merge_into_database("alpha", payload, db)

    assert stats.messages_added == 1
    with sqlite3.connect(db) as conn:
        rows = [r[0] for r in conn.execute("SELECT content FROM project_history WHERE project='alpha'")]
    assert "from the laptop" in rows
    assert "shared" in rows


def test_merge_is_idempotent(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one"), ("assistant", "two")])
    payload = chats.export_project("alpha", db)

    first = chats.merge_into_database("alpha", payload, db)
    second = chats.merge_into_database("alpha", payload, db)

    assert first.messages_added == 0
    assert second.messages_added == 0
    with sqlite3.connect(db) as conn:
        (count,) = conn.execute(
            "SELECT COUNT(*) FROM project_history WHERE project='alpha'"
        ).fetchone()
    assert count == 2


def test_merge_deduplicates_by_content_when_no_client_id(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "hello")])
    payload = chats.export_project("alpha", db)
    # Same message arriving from the other machine without a client id: it must
    # not be inserted a second time.
    duplicate = dict(payload["messages"][0])
    duplicate["client_message_id"] = ""
    payload["messages"].append(duplicate)

    stats = chats.merge_into_database("alpha", payload, db)

    with sqlite3.connect(db) as conn:
        (count,) = conn.execute(
            "SELECT COUNT(*) FROM project_history WHERE project='alpha'"
        ).fetchone()
    assert count == 1
    assert stats.messages_added == 0


def test_merge_adds_a_chat_created_elsewhere(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one")])
    payload = chats.export_project("alpha", db)
    payload["chats"].append(
        {"id": "chat_from_laptop", "name": "Laptop chat", "created_at": "2030-01-01T00:00:00+00:00"}
    )
    payload["messages"].append(
        {
            "chat_id": "chat_from_laptop",
            "timestamp": "2030-01-01T00:00:01+00:00",
            "role": "user",
            "content": "written on the laptop",
            "client_message_id": "laptop-2",
            "attachments": "[]",
        }
    )

    stats = chats.merge_into_database("alpha", payload, db)

    assert stats.chats_added == 1
    assert stats.messages_added == 1
    with sqlite3.connect(db) as conn:
        rows = [
            r[0]
            for r in conn.execute(
                "SELECT content FROM project_history WHERE chat_id='chat_from_laptop'"
            )
        ]
    assert rows == ["written on the laptop"]


def test_merge_skips_a_message_whose_chat_is_unknown(db, project_dir):
    # A message referring to a chat that neither exists locally nor arrives in
    # the export would be invisible in every chat; dropping it is better than
    # hiding it.
    make_project(db, "alpha", project_dir, messages=[("user", "one")])
    payload = chats.export_project("alpha", db)
    payload["messages"].append(
        {
            "chat_id": "chat_that_does_not_exist",
            "timestamp": "2030-01-01T00:00:00+00:00",
            "role": "user",
            "content": "orphan",
            "client_message_id": "orphan-1",
            "attachments": "[]",
        }
    )

    stats = chats.merge_into_database("alpha", payload, db)

    assert stats.messages_added == 0


def test_merge_refuses_a_newer_format(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one")])

    stats = chats.merge_into_database("alpha", {"version": 999, "messages": []}, db)

    assert stats.messages_added == 0
    assert stats.notes


def test_merge_does_nothing_for_an_unknown_project(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "one")])
    payload = chats.export_project("alpha", db)

    stats = chats.merge_into_database("does-not-exist", payload, db)

    assert not stats.changed
    assert stats.notes


def test_newer_settings_win_older_ones(db, project_dir):
    store, _ = make_project(db, "alpha", project_dir)
    payload = chats.export_project("alpha", db)
    payload["updated_at"] = "2999-01-01T00:00:00+00:00"
    payload["settings"]["description"] = "written on the other machine"

    stats = chats.merge_into_database("alpha", payload, db)

    assert stats.settings_applied
    with sqlite3.connect(db) as conn:
        (description,) = conn.execute(
            "SELECT description FROM projects WHERE name='alpha'"
        ).fetchone()
    assert description == "written on the other machine"


def test_older_settings_do_not_overwrite_newer_ones(db, project_dir):
    make_project(db, "alpha", project_dir)
    payload = chats.export_project("alpha", db)
    payload["updated_at"] = "1999-01-01T00:00:00+00:00"
    payload["settings"]["description"] = "stale"

    stats = chats.merge_into_database("alpha", payload, db)

    assert not stats.settings_applied
    with sqlite3.connect(db) as conn:
        (description,) = conn.execute(
            "SELECT description FROM projects WHERE name='alpha'"
        ).fetchone()
    assert description != "stale"


def test_round_trip_through_disk(db, project_dir):
    make_project(db, "alpha", project_dir, messages=[("user", "on disk")])

    assert chats.refresh_export("alpha", project_dir, db) is True
    assert os.path.isfile(chats.export_path(project_dir))

    stats = chats.apply_export("alpha", project_dir, db)

    assert stats.messages_added == 0  # already present locally


# ─── Large imports share the database with the running server ────────────────

def _export_with_a_chat_that_has_saved_state(tmp_path, activity_rows):
    """An export from another machine: one chat whose agent already holds its
    two messages in `agent_state`, plus `activity_rows` rows of activity."""
    source_db = str(tmp_path / "source.db")
    store = ProjectStore(source_db)
    store.create("alpha", "plan", "ollama/test", project_name="alpha", project_path=str(tmp_path / "src"))
    store.create_chat("alpha", "laptop-chat", "Laptop chat")
    project = store.load("alpha", "laptop-chat")
    store.append_message(project, "user", "question")
    store.append_message(project, "assistant", "answer")
    store.save_chat_agent_state("alpha", "laptop-chat", {
        "internal_history": [
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": "answer"},
        ],
        "recursive_summary": "",
    })
    for index in range(activity_rows):
        store.append_activity(project, "stream_chunk", content=f"token {index}")
    store.close_activity_connection()
    return chats.export_project("alpha", source_db)


def _destination(tmp_path):
    db_path = str(tmp_path / "destination.db")
    store = ProjectStore(db_path)
    store.create("alpha", "plan", "ollama/test", project_name="alpha", project_path=str(tmp_path / "dst"))
    return store, db_path


def _count(db_path, table):
    with sqlite3.connect(db_path) as conn:
        (count,) = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE project='alpha'").fetchone()
    return count


def test_activity_is_imported_in_batches_that_let_other_writers_in(tmp_path, monkeypatch):
    payload = _export_with_a_chat_that_has_saved_state(tmp_path, activity_rows=7)
    _, db_path = _destination(tmp_path)
    monkeypatch.setattr(chats, "_ACTIVITY_BATCH_ROWS", 3)

    # Runs in each pause between batches. A writer that will not wait at all
    # (timeout 0) must get the write lock there: that is what keeps the
    # server's own writes from queueing behind the whole import.
    seen = []

    def other_writer(_seconds):
        conn = sqlite3.connect(db_path, timeout=0)
        try:
            conn.execute("BEGIN IMMEDIATE")
            seen.append(conn.execute(
                "SELECT COUNT(*) FROM project_activity WHERE project='alpha'"
            ).fetchone()[0])
            conn.rollback()
        finally:
            conn.close()

    monkeypatch.setattr(chats, "time", type("Clock", (), {"sleep": staticmethod(other_writer)}))

    stats = chats.merge_into_database("alpha", payload, db_path, adopt_settings=True)

    assert stats.activity_added == 7
    assert seen == [3, 6, 7]
    assert _count(db_path, "project_activity") == 7


@pytest.mark.parametrize("failing_table, failing_call", [
    ("project_history", 1),   # inside the chats-and-messages transaction
    ("project_activity", 2),  # after the first activity batch committed
])
def test_a_merge_that_failed_part_way_can_be_run_again(tmp_path, monkeypatch, failing_table, failing_call):
    payload = _export_with_a_chat_that_has_saved_state(tmp_path, activity_rows=7)
    store, db_path = _destination(tmp_path)
    monkeypatch.setattr(chats, "_ACTIVITY_BATCH_ROWS", 3)
    real_insert = chats._insert_rows
    calls = {"n": 0}

    def flaky_insert(conn, table, rows):
        if table == failing_table:
            calls["n"] += 1
            if calls["n"] == failing_call:
                raise sqlite3.OperationalError("database is locked")
        return real_insert(conn, table, rows)

    monkeypatch.setattr(chats, "_insert_rows", flaky_insert)
    with pytest.raises(sqlite3.OperationalError):
        chats.merge_into_database("alpha", payload, db_path, adopt_settings=True)
    monkeypatch.setattr(chats, "_insert_rows", real_insert)

    chats.merge_into_database("alpha", payload, db_path, adopt_settings=True)

    assert _count(db_path, "project_history") == 2
    assert _count(db_path, "project_activity") == 7
    # The chat arrived with an agent state that already holds both messages.
    # Had the chat been committed without them, the retry would have counted
    # it as a chat with saved state and queued them to its agent a second time.
    assert store.get_chat_external_turns("alpha", "laptop-chat") == []
