"""Tests for ProjectStore and ProjectData.

Verifies:
1. ProjectStore.create always includes 'opalatex' in skills
2. ProjectStore.load round-trips all ProjectData fields correctly
3. ProjectStore.rename fails if target name already exists
4. ProjectData.context_header produces the expected format
5. ProjectStore.save persists changes and reload reflects them
6. ProjectStore.delete removes project and history
"""

import os
import tempfile
import pytest

from opalatex.project import ProjectData, ProjectStore


@pytest.fixture
def store(tmp_path):
    db = str(tmp_path / "test.db")
    return ProjectStore(db_path=db)


def _base_args(**overrides):
    defaults = dict(
        name="myproj",
        mode="plan",
        model="fake/model",
        project_name="My Project",
        project_path="/home/user/myproject",
        skills=["python_subprocess"],
        description="A test project",
    )
    defaults.update(overrides)
    return defaults


# ---------------------------------------------------------------------------
# 1. create always adds 'opalatex'
# ---------------------------------------------------------------------------

def test_create_always_includes_opalatex(store):
    """Skills list must always contain 'opalatex', even if not passed."""
    p = store.create(**_base_args(skills=["react_vite"]))
    assert "opalatex" in p.skills


def test_create_without_skills_defaults_to_opalatex(store):
    """When skills is None, result must still have 'opalatex'."""
    p = store.create(**_base_args(skills=None))
    assert p.skills == ["opalatex"]


def test_create_does_not_duplicate_opalatex(store):
    """If opalatex is explicitly in the list, it must not appear twice."""
    p = store.create(**_base_args(skills=["opalatex", "html_css_js"]))
    assert p.skills.count("opalatex") == 1


# ---------------------------------------------------------------------------
# 2. load round-trips all fields
# ---------------------------------------------------------------------------

def test_load_roundtrips_all_fields(store):
    args = _base_args()
    store.create(**args)
    loaded = store.load("myproj")

    assert loaded is not None
    assert loaded.name == "myproj"
    assert loaded.mode == "plan"
    assert loaded.model == "fake/model"
    assert loaded.project_name == "My Project"
    assert loaded.project_path == "/home/user/myproject"
    assert "opalatex" in loaded.skills
    assert "python_subprocess" in loaded.skills
    assert loaded.description == "A test project"
    assert loaded.compile_on_save_partial is True
    assert loaded.compile_on_save_full is False


def test_load_nonexistent_returns_none(store):
    assert store.load("ghost") is None


def test_compile_on_save_settings_persist(store):
    project = store.create(**_base_args())
    project.compile_on_save_partial = False
    project.compile_on_save_full = True
    store.save(project)

    loaded = store.load("myproj")
    listed = store.list_projects()[0]

    assert loaded.compile_on_save_partial is False
    assert loaded.compile_on_save_full is True
    assert listed["compile_on_save_partial"] is False
    assert listed["compile_on_save_full"] is True


def test_compile_on_save_settings_are_mutually_exclusive(store):
    project = store.create(**_base_args())
    project.compile_on_save_partial = True
    project.compile_on_save_full = True
    store.save(project)

    loaded = store.load("myproj")
    listed = store.list_projects()[0]

    assert loaded.compile_on_save_partial is False
    assert loaded.compile_on_save_full is True
    assert listed["compile_on_save_partial"] is False
    assert listed["compile_on_save_full"] is True


def test_compile_on_save_settings_can_be_disabled(store):
    project = store.create(**_base_args())
    project.compile_on_save_partial = False
    project.compile_on_save_full = False
    store.save(project)

    loaded = store.load("myproj")
    listed = store.list_projects()[0]

    assert loaded.compile_on_save_partial is False
    assert loaded.compile_on_save_full is False
    assert listed["compile_on_save_partial"] is False
    assert listed["compile_on_save_full"] is False


# ---------------------------------------------------------------------------
# 3. rename fails if target exists
# ---------------------------------------------------------------------------

def test_rename_fails_if_target_exists(store):
    store.create(**_base_args(name="proj_a"))
    store.create(**_base_args(name="proj_b"))
    result = store.rename("proj_a", "proj_b")
    assert result is False
    # Both should still exist under original names
    assert store.exists("proj_a")
    assert store.exists("proj_b")


def test_rename_succeeds_when_target_is_free(store):
    store.create(**_base_args(name="proj_a"))
    result = store.rename("proj_a", "proj_renamed")
    assert result is True
    assert not store.exists("proj_a")
    assert store.exists("proj_renamed")


# ---------------------------------------------------------------------------
# 4. context_header format
# ---------------------------------------------------------------------------

def test_context_header_format():
    p = ProjectData(
        name="myproj",
        project_name="My Project",
        project_path="/home/user/myproject",
    )
    header = p.context_header()
    assert header.startswith("[PROJECT:")
    assert "My Project" in header
    assert "/home/user/myproject" in header
    # Must match the format the orchestrator parses
    assert "PATH:" in header


def test_context_header_uses_name_when_project_name_empty():
    p = ProjectData(name="fallback_name", project_name="", project_path="/some/path")
    header = p.context_header()
    assert "fallback_name" in header


# ---------------------------------------------------------------------------
# 5. save persists changes
# ---------------------------------------------------------------------------

def test_save_persists_description_change(store):
    store.create(**_base_args())
    p = store.load("myproj")
    p.description = "Updated description"
    store.save(p)

    reloaded = store.load("myproj")
    assert reloaded.description == "Updated description"


def test_save_persists_git_root_path(store, tmp_path):
    proj_dir = tmp_path / "project"
    git_root = proj_dir / "paper"
    git_root.mkdir(parents=True)
    store.create(**_base_args(project_path=str(proj_dir)))

    p = store.load("myproj")
    p.git_root_path = str(git_root)
    store.save(p)

    reloaded = store.load("myproj")
    assert reloaded.git_root_path == str(git_root)

    listed = store.list_projects()
    assert listed[0]["git_root_path"] == str(git_root)


def test_save_always_keeps_opalatex_in_skills(store):
    """Even if someone accidentally removes opalatex before save, it must be restored."""
    store.create(**_base_args())
    p = store.load("myproj")
    p.skills = ["html_css_js"]  # opalatex removed
    store.save(p)

    reloaded = store.load("myproj")
    assert "opalatex" in reloaded.skills


# ---------------------------------------------------------------------------
# 6. delete removes project and history
# ---------------------------------------------------------------------------

def test_delete_removes_project(store):
    store.create(**_base_args())
    assert store.exists("myproj")
    store.delete("myproj")
    assert not store.exists("myproj")
    assert store.load("myproj") is None


def test_delete_removes_history(store):
    store.create(**_base_args())
    p = store.load("myproj")
    store.append_message(p, "user", "hello")
    store.append_message(p, "assistant", "hi")

    store.delete("myproj")
    # Re-creating with same name should start with empty history
    store.create(**_base_args())
    p2 = store.load("myproj")
    assert p2.history == []


def test_append_message_persists_attachments(store):
    store.create(**_base_args())
    p = store.load("myproj")
    att = {"type": "image", "data": "abc123", "mime": "image/jpeg", "name": "shot.jpg"}

    store.append_message(p, "user", "describe this", attachments=[att])

    loaded = store.load("myproj", chat_id=p.current_chat_id)
    assert loaded.history[0]["content"] == "describe this"
    assert loaded.history[0]["_attachments"] == [att]


def test_branch_chat_copies_attachments(store):
    store.create(**_base_args())
    p = store.load("myproj")
    source_chat = p.current_chat_id
    att = {"type": "image", "data": "abc123", "mime": "image/jpeg", "name": "shot.jpg"}
    store.append_message(p, "user", "describe this", attachments=[att])

    store.branch_chat("myproj", source_chat, "branch-1", "Branch", 0)

    loaded = store.load("myproj", chat_id="branch-1")
    assert loaded.history[0]["_attachments"] == [att]


def test_truncate_chat_history_from_index_removes_suffix(store):
    store.create(**_base_args())
    p = store.load("myproj")
    store.append_message(p, "user", "first")
    store.append_message(p, "assistant", "first reply")
    store.append_message(p, "user", "second")

    deleted_ids = store.truncate_chat_history_from_index("myproj", p.current_chat_id, 1)

    loaded = store.load("myproj", chat_id=p.current_chat_id)
    assert len(deleted_ids) == 2
    assert [m["content"] for m in loaded.history] == ["first"]


def test_branch_chat_prefix_copies_messages_before_index(store):
    store.create(**_base_args())
    p = store.load("myproj")
    source_chat = p.current_chat_id
    att = {"type": "image", "data": "abc123", "mime": "image/jpeg", "name": "shot.jpg"}
    store.append_message(p, "user", "first", attachments=[att])
    store.append_message(p, "assistant", "first reply")
    store.append_message(p, "user", "second")

    copied = store.branch_chat_prefix("myproj", source_chat, "branch-edit", "Edited", 2)

    loaded = store.load("myproj", chat_id="branch-edit")
    assert [m["content"] for m in copied] == ["first", "first reply"]
    assert [m["content"] for m in loaded.history] == ["first", "first reply"]
    assert loaded.history[0]["_attachments"] == [att]


# ---------------------------------------------------------------------------
# 7. list_projects ordering
# ---------------------------------------------------------------------------

def test_list_projects_most_recent_first(store):
    store.create(**_base_args(name="old_proj"))
    store.create(**_base_args(name="new_proj"))
    projects = store.list_projects()
    names = [p["name"] for p in projects]
    # new_proj was created after old_proj, so it should appear first
    assert names.index("new_proj") < names.index("old_proj")


def test_create_initializes_shadow_git(store, tmp_path):
    proj_dir = tmp_path / "my_new_project"
    p = store.create(
        name="shadow_git_test",
        mode="hybrid",
        model="fake/model",
        project_name="Shadow Git Test",
        project_path=str(proj_dir),
    )
    # Check that .opalatex/.git directory exists
    git_dir = proj_dir / ".opalatex" / ".git"
    assert git_dir.exists()
    assert git_dir.is_dir()


def test_set_project_context_loads_env_and_propagates_keys(tmp_path):
    import os
    from opalatex.tools import set_project_context
    from opalatex.project import ProjectData
    
    proj_dir = tmp_path / "my_env_project"
    proj_dir.mkdir()
    env_file = proj_dir / ".env"
    env_file.write_text("CUSTOM_VAR=my_value\nOPENAI_API_KEY=file_key\nOPENAI_API_BASE=file_base\nWORKER_API_KEY=file_w_key\nWORKER_API_BASE=file_w_base\n")
    
    # 1. Test loading from file
    p = ProjectData(name="test", project_path=str(proj_dir))
    set_project_context(p)
    
    assert os.environ.get("CUSTOM_VAR") == "my_value"
    assert os.environ.get("OPENAI_API_KEY") == "file_key"
    assert os.environ.get("OPENAI_API_BASE") == "file_base"
    assert os.environ.get("WORKER_API_KEY") == "file_w_key"
    assert os.environ.get("WORKER_API_BASE") == "file_w_base"
    
    # Clean up custom var
    os.environ.pop("CUSTOM_VAR", None)
    
    # 2. Test session properties overriding env
    p_with_keys = ProjectData(
        name="test",
        project_path=str(proj_dir),
        api_key="session_key",
        api_base="session_base",
        worker_api_key="session_w_key",
        worker_api_base="session_w_base"
    )
    set_project_context(p_with_keys)
    assert os.environ.get("OPENAI_API_KEY") == "session_key"
    assert os.environ.get("OPENAI_API_BASE") == "session_base"
    assert os.environ.get("WORKER_API_KEY") == "session_w_key"
    assert os.environ.get("WORKER_API_BASE") == "session_w_base"


def test_store_load_saves_and_loads_api_credentials(store, tmp_path):
    proj_dir = tmp_path / "creds_project"
    proj_dir.mkdir(exist_ok=True)
    p = store.create(
        name="creds_proj",
        mode="plan",
        model="fake/model",
        project_name="Creds Project",
        project_path=str(proj_dir),
        api_key="my_orch_key",
        api_base="my_orch_base",
        worker_api_key="my_worker_key",
        worker_api_base="my_worker_base"
    )
    
    loaded = store.load("creds_proj")
    assert loaded.api_key == "my_orch_key"
    assert loaded.api_base == "my_orch_base"
    assert loaded.worker_api_key == "my_worker_key"
    assert loaded.worker_api_base == "my_worker_base"

    # Now modify and save
    loaded.api_key = "new_orch_key"
    loaded.worker_api_key = "new_worker_key"
    store.save(loaded)

    reloaded = store.load("creds_proj")
    assert reloaded.api_key == "new_orch_key"
    assert reloaded.worker_api_key == "new_worker_key"


