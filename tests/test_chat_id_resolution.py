"""A chat id either names a stored chat or it is an error.

The panel used to reopen showing "Main Chat" in the selector while the body
held a different conversation: the client persisted the literal ``"main"`` —
an id no chat ever carries — and the store answered it with whatever chat had
been created last. These tests pin both halves of that contract: the default
chat is resolved explicitly, and an unknown id fails instead of substituting.
"""
import pytest

from opalatex.project import (
    ChatNotFoundError,
    MAIN_CHAT_NAME,
    ProjectData,
    ProjectStore,
    main_chat_id,
)


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(db_path=str(tmp_path / "projects.db"))


def _project_with_two_chats(store):
    project = store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", "second", "Second Chat")

    main = store.load("myproj", chat_id=main_chat_id("myproj"))
    store.append_message(main, "user", "message in main")
    second = store.load("myproj", chat_id="second")
    store.append_message(second, "user", "message in second")
    return project


def test_created_project_uses_a_stored_main_chat_id(store):
    project = store.create("myproj", "chat", "gpt-4")

    assert project.current_chat_id == main_chat_id("myproj") == "main_myproj"
    assert project.chats == [{"id": "main_myproj", "name": MAIN_CHAT_NAME}]


def test_load_without_chat_id_resolves_to_the_main_chat(store):
    _project_with_two_chats(store)

    loaded = store.load("myproj")

    # Not the most recently created chat: the default is the main chat.
    assert loaded.current_chat_id == main_chat_id("myproj")
    assert [m["content"] for m in loaded.history] == ["message in main"]


def test_load_with_unknown_chat_id_raises_instead_of_serving_another_chat(store):
    _project_with_two_chats(store)

    with pytest.raises(ChatNotFoundError) as excinfo:
        store.load("myproj", chat_id="main")

    assert "main" in str(excinfo.value)
    assert "myproj" in str(excinfo.value)


def test_load_with_deleted_chat_id_raises(store):
    _project_with_two_chats(store)
    store.delete_chat("myproj", "second")

    with pytest.raises(ChatNotFoundError):
        store.load("myproj", chat_id="second")


def test_load_with_explicit_chat_id_returns_that_chats_history(store):
    _project_with_two_chats(store)

    loaded = store.load("myproj", chat_id="second")

    assert loaded.current_chat_id == "second"
    assert [m["content"] for m in loaded.history] == ["message in second"]


def test_main_chat_cannot_be_deleted(store):
    store.create("myproj", "chat", "gpt-4")

    with pytest.raises(ValueError):
        store.delete_chat("myproj", main_chat_id("myproj"))

    assert store.load("myproj").chats == [{"id": "main_myproj", "name": MAIN_CHAT_NAME}]


def test_load_repairs_a_project_left_without_any_chat(store):
    store.create("myproj", "chat", "gpt-4")
    with __import__("sqlite3").connect(store.db_path) as conn:
        conn.execute("DELETE FROM project_chats WHERE project = ?", ("myproj",))

    loaded = store.load("myproj")

    assert loaded.chats == [{"id": "main_myproj", "name": MAIN_CHAT_NAME}]
    assert loaded.current_chat_id == "main_myproj"


def test_project_data_always_carries_a_real_chat_id():
    # Built outside the store (the agent's in-memory fallback project).
    project = ProjectData(name="ephemeral")

    assert project.current_chat_id == main_chat_id("ephemeral")


def test_last_remaining_chat_cannot_be_deleted(store):
    """Projects whose main chat an older build deleted are still protected."""
    store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", "only-one", "Only Chat")
    with __import__("sqlite3").connect(store.db_path) as conn:
        conn.execute(
            "DELETE FROM project_chats WHERE project = ? AND id = ?",
            ("myproj", main_chat_id("myproj")),
        )

    with pytest.raises(ValueError, match="last chat"):
        store.delete_chat("myproj", "only-one")

    assert [c["id"] for c in store.load("myproj").chats] == ["only-one"]


def test_load_falls_back_to_the_first_chat_when_the_main_chat_is_gone(store):
    store.create("myproj", "chat", "gpt-4")
    store.create_chat("myproj", "kept", "Kept Chat")
    kept = store.load("myproj", chat_id="kept")
    store.append_message(kept, "user", "message in kept")
    with __import__("sqlite3").connect(store.db_path) as conn:
        conn.execute(
            "DELETE FROM project_chats WHERE project = ? AND id = ?",
            ("myproj", main_chat_id("myproj")),
        )

    loaded = store.load("myproj")

    assert loaded.current_chat_id == "kept"
    assert [m["content"] for m in loaded.history] == ["message in kept"]
