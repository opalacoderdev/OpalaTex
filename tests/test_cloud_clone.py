"""Bringing a mirrored project down onto a second machine.

The mirror exists so a project can be continued somewhere else, which only works
if the *other* machine can get the project in the first place. These tests cover
that half: enumerating what is in the account, and cloning one of those projects
into an empty folder.

They run against `local_folder`, the same real provider the sync contract suite
uses, so the whole path is exercised offline and without credentials.
"""

import json
import os
from unittest.mock import AsyncMock

import pytest

from opalatex.cloud import chats, service
from opalatex.cloud.base import Capabilities, CloudError
from opalatex.cloud.providers.local_folder import LocalFolderProvider
from opalatex.cloud.state import CloudSettings, load_state, save_settings
from opalatex.ide_server import AsyncHTTPServer
from opalatex.project import ProjectStore


# ─── Fixtures & helpers ───────────────────────────────────────────────────────

@pytest.fixture
def remote_base(tmp_path):
    path = tmp_path / "remote"
    path.mkdir()
    return str(path)


def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)
    return absolute


def read(root, rel_path):
    with open(os.path.join(root, rel_path.replace("/", os.sep)), encoding="utf-8") as handle:
        return handle.read()


def seed_remote(remote_base, folder, files):
    """Put a project into the account the way an earlier push would have."""
    root = os.path.join(remote_base, folder)
    os.makedirs(root, exist_ok=True)
    for rel_path, content in files.items():
        write(root, rel_path, content)
    return root


def snapshot(root):
    """Every file under `root` with its bytes, for before/after comparisons."""
    captured = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            absolute = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(absolute, root).replace(os.sep, "/")
            with open(absolute, "rb") as handle:
                captured[rel_path] = handle.read()
    return captured


def clone(remote_base, folder, destination, **kwargs):
    return service.clone_project(
        "local_folder",
        folder,
        destination,
        provider_config={"base_dir": remote_base},
        **kwargs,
    )


# ─── Finding what is in the account ───────────────────────────────────────────

def test_projects_in_the_account_are_listed(remote_base):
    seed_remote(remote_base, "thesis", {"main.tex": "\\section{One}"})
    seed_remote(remote_base, "article", {"main.tex": "\\section{Two}"})

    found = service.list_remote_projects("local_folder", {"base_dir": remote_base})

    assert [project.name for project in found] == ["article", "thesis"]
    # The handle travels with the name so the clone addresses the very folder
    # that was listed, rather than resolving the name a second time.
    assert all(os.path.isdir(project.root) for project in found)


def test_loose_files_beside_the_projects_are_not_offered(remote_base):
    seed_remote(remote_base, "thesis", {"main.tex": "body"})
    write(remote_base, "notes.txt", "not a project")

    found = service.list_remote_projects("local_folder", {"base_dir": remote_base})

    assert [project.name for project in found] == ["thesis"]


def test_an_account_with_nothing_in_it_lists_nothing(remote_base):
    assert service.list_remote_projects("local_folder", {"base_dir": remote_base}) == []


def test_a_backend_that_cannot_enumerate_says_so_instead_of_answering_empty(remote_base):
    class SingleFolderProvider(LocalFolderProvider):
        """A backend pointed at one folder, as a plain WebDAV URL would be."""

        def capabilities(self):
            return Capabilities(checksum_algorithm="sha256", project_listing=False)

    with pytest.raises(CloudError):
        service.list_remote_projects(
            "local_folder", provider=SingleFolderProvider(remote_base)
        )


# ─── Cloning ──────────────────────────────────────────────────────────────────

def test_clone_brings_down_every_file(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {
        "main.tex": "\\section{Intro}",
        "chapters/one.tex": "chapter one",
    })
    destination = str(tmp_path / "work" / "thesis")

    outcome = clone(remote_base, "thesis", destination)

    assert outcome.ok, outcome.error
    assert read(destination, "main.tex") == "\\section{Intro}"
    assert read(destination, "chapters/one.tex") == "chapter one"


def test_clone_leaves_the_project_configured_to_keep_syncing(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "body"})
    destination = str(tmp_path / "thesis")

    clone(remote_base, "thesis", destination)

    settings = load_state(destination).settings
    assert settings.enabled
    assert settings.provider == "local_folder"
    assert settings.remote_folder == "thesis"
    assert settings.provider_config == {"base_dir": remote_base}


def test_clone_records_a_baseline_so_the_next_pass_moves_nothing(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "body", "refs.bib": "@book{}"})
    destination = str(tmp_path / "thesis")

    # Conversations are left out here so the pass that follows has nothing to
    # do but compare files: the export is regenerated from this machine's own
    # (empty) database, which is a change of its own.
    clone(remote_base, "thesis", destination, settings_overrides={"include_chats": False})

    # Without a baseline the next two-way pass would see two independent copies
    # of every file and report the whole project as conflicted.
    state = load_state(destination)
    assert set(state.entries) >= {"main.tex", "refs.bib"}

    provider = LocalFolderProvider(remote_base)
    outcome = service.sync_project("thesis", destination, provider=provider)
    assert outcome.report.changed == 0
    assert not outcome.report.conflicts


def test_clone_never_writes_to_the_remote(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "the original"})
    before = snapshot(os.path.join(remote_base, "thesis"))
    destination = str(tmp_path / "thesis")

    clone(remote_base, "thesis", destination)

    assert snapshot(os.path.join(remote_base, "thesis")) == before


def test_clone_refuses_a_folder_that_already_has_files_in_it(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "remote"})
    destination = tmp_path / "busy"
    destination.mkdir()
    write(str(destination), "main.tex", "something the user already had")

    outcome = clone(remote_base, "thesis", str(destination))

    # Pulling into a directory that already holds files would reconcile them
    # against the remote instead of downloading a copy of the project.
    assert not outcome.ok
    assert "not empty" in outcome.error
    assert read(str(destination), "main.tex") == "something the user already had"


def test_clone_refuses_a_destination_that_is_a_file(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "remote"})
    destination = write(str(tmp_path), "thesis", "this is a file")

    outcome = clone(remote_base, "thesis", destination)

    assert not outcome.ok
    assert "not a directory" in outcome.error


def test_clone_accepts_an_empty_folder_the_user_made_first(remote_base, tmp_path):
    seed_remote(remote_base, "thesis", {"main.tex": "body"})
    destination = tmp_path / "empty"
    destination.mkdir()

    outcome = clone(remote_base, "thesis", str(destination))

    assert outcome.ok, outcome.error
    assert read(str(destination), "main.tex") == "body"


def test_clone_addresses_the_folder_it_was_handed(remote_base, tmp_path):
    """The listed handle wins over the name, so no second folder is created."""
    root = seed_remote(remote_base, "thesis", {"main.tex": "body"})
    destination = str(tmp_path / "copy")

    outcome = clone(remote_base, "thesis", destination, remote_root=root)

    assert outcome.ok, outcome.error
    assert sorted(os.listdir(remote_base)) == ["thesis"]


def test_a_missing_project_downloads_nothing_rather_than_creating_it(remote_base, tmp_path):
    destination = str(tmp_path / "ghost")

    outcome = clone(remote_base, "ghost", destination)

    # `ensure_root` creates the remote folder, so the pass itself succeeds; what
    # matters is that it is empty and the user is not handed someone else's data.
    assert outcome.report is not None
    assert outcome.report.downloaded == []


# ─── The endpoint: download, register, and open ───────────────────────────────

def make_server():
    server = AsyncHTTPServer()
    responses = []

    def mock_send_response(_writer, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode("utf-8"))))

    server.send_response = mock_send_response
    return server, responses


async def call(server, path, payload):
    await server.route_api(
        "POST", path, {}, {}, json.dumps(payload).encode("utf-8"), AsyncMock()
    )


def source_machine(tmp_path, remote_base, monkeypatch, name="thesis"):
    """A project on machine A, already pushed to the shared remote."""
    root = tmp_path / "machine-a"
    root.mkdir()
    project_dir = root / name
    project_dir.mkdir()
    db_path = str(root / "sessions.db")

    store = ProjectStore(db_path)
    project = store.create(
        # Not an `ollama/` id on purpose: registering one triggers a background
        # `ollama pull`, and a test must not reach for the network.
        name, "plan", "openai/gpt-4o-mini", project_name=name, project_path=str(project_dir),
        description="written on machine A",
    )
    store.create_chat(name, f"chat-{name}", "Chat")
    project = store.load(name)
    store.append_message(project, "user", "a question I asked on machine A")
    store.close_activity_connection()

    write(str(project_dir), "main.tex", "\\section{Intro}")
    save_settings(str(project_dir), CloudSettings(
        enabled=True,
        provider="local_folder",
        remote_folder=name,
        provider_config={"base_dir": remote_base},
    ))
    monkeypatch.setattr(chats, "_default_db_path", lambda: db_path)
    outcome = service.sync_project(name, str(project_dir), provider=LocalFolderProvider(remote_base))
    assert outcome.report.ok, outcome.error
    return {"path": str(project_dir), "db": db_path, "store": store, "name": name}


@pytest.mark.asyncio
async def test_the_endpoint_lists_what_is_in_the_account(tmp_path, remote_base, monkeypatch):
    source_machine(tmp_path, remote_base, monkeypatch)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", str(tmp_path / "machine-b.db"))
    server, responses = make_server()

    await call(server, "/api/cloud/remote-projects", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
    })

    status, payload = responses[-1]
    assert status == 200
    assert [p["name"] for p in payload["projects"]] == ["thesis"]
    # Nothing on this machine mirrors it yet.
    assert payload["projects"][0]["local"] is None


@pytest.mark.asyncio
async def test_the_endpoint_marks_a_project_this_machine_already_has(
    tmp_path, remote_base, monkeypatch
):
    source = source_machine(tmp_path, remote_base, monkeypatch)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", source["db"])
    server, responses = make_server()

    await call(server, "/api/cloud/remote-projects", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
    })

    status, payload = responses[-1]
    assert status == 200
    # Downloading it again would give one remote folder two local working
    # copies, so the UI has to be able to say "you already have this".
    assert payload["projects"][0]["local"]["project_path"] == source["path"]


@pytest.mark.asyncio
async def test_the_endpoint_downloads_registers_and_carries_the_conversations(
    tmp_path, remote_base, monkeypatch
):
    source_machine(tmp_path, remote_base, monkeypatch)

    # Machine B: a different database, nothing in it.
    db_path = str(tmp_path / "machine-b" / "sessions.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    monkeypatch.setattr(chats, "_default_db_path", lambda: db_path)
    parent = tmp_path / "machine-b" / "projects"
    parent.mkdir(parents=True)
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
    })

    status, payload = responses[-1]
    assert status == 200, payload
    destination = payload["project_path"]
    assert read(destination, "main.tex") == "\\section{Intro}"

    # The project is registered here, so it appears in the project list...
    store = ProjectStore(db_path)
    assert store.find_by_path(destination) == payload["name"]

    # ...its history came with it...
    loaded = store.load(payload["name"])
    assert any(m["content"] == "a question I asked on machine A" for m in loaded.history)

    # ...and the settings the user chose on machine A were adopted, which
    # last-writer-wins alone would not do: the row here was created seconds ago
    # and is therefore always the "newer" one.
    assert loaded.description == "written on machine A"
    assert loaded.model == "openai/gpt-4o-mini"


@pytest.mark.asyncio
async def test_the_downloaded_project_keeps_its_own_skill_set(
    tmp_path, remote_base, monkeypatch
):
    source = source_machine(tmp_path, remote_base, monkeypatch)
    write(source["path"], "skills.yaml", "skills:\n- latex-figures\n")
    service.sync_project(
        source["name"], source["path"], provider=LocalFolderProvider(remote_base)
    )

    db_path = str(tmp_path / "machine-b" / "sessions.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    monkeypatch.setattr(chats, "_default_db_path", lambda: db_path)
    parent = tmp_path / "machine-b" / "projects"
    parent.mkdir(parents=True)
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
    })

    status, payload = responses[-1]
    assert status == 200, payload
    # Registering a project scaffolds a default skills.yaml. Doing that over a
    # downloaded one would drop the skill set here *and* sync the loss back.
    assert "latex-figures" in read(payload["project_path"], "skills.yaml")
    assert "latex-figures" in payload["skills"]


@pytest.mark.asyncio
async def test_the_endpoint_refuses_a_folder_that_already_holds_a_project(
    tmp_path, remote_base, monkeypatch
):
    source = source_machine(tmp_path, remote_base, monkeypatch)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", source["db"])
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": os.path.dirname(source["path"]),
        "folderName": os.path.basename(source["path"]),
    })

    status, payload = responses[-1]
    assert status == 400
    assert payload["error"]


@pytest.mark.asyncio
async def test_the_endpoint_refuses_a_folder_name_that_is_a_path(
    tmp_path, remote_base, monkeypatch
):
    source_machine(tmp_path, remote_base, monkeypatch)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", str(tmp_path / "machine-b.db"))
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(tmp_path),
        "folderName": f"..{os.sep}escaped",
    })

    status, payload = responses[-1]
    assert status == 400
    assert "single folder name" in payload["error"]


# ─── Background downloads (non-blocking UI flow) ─────────────────────────────

async def call_get(server, path, query=None):
    await server.route_api("GET", path, query or {}, {}, b"", AsyncMock())


@pytest.mark.asyncio
async def test_background_clone_returns_202_and_completes_without_blocking_server(
    tmp_path, remote_base, monkeypatch
):
    import asyncio
    import threading

    source_machine(tmp_path, remote_base, monkeypatch)

    db_path = str(tmp_path / "machine-b" / "sessions.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    monkeypatch.setattr(chats, "_default_db_path", lambda: db_path)
    parent = tmp_path / "machine-b" / "projects"
    parent.mkdir(parents=True)

    entered = threading.Event()
    release = threading.Event()
    original_download = LocalFolderProvider.download

    def gated_download(self, *args, **kwargs):
        entered.set()
        assert release.wait(timeout=5.0), "test timed out waiting to release download"
        return original_download(self, *args, **kwargs)

    monkeypatch.setattr(LocalFolderProvider, "download", gated_download)

    read_calls = []
    original_read_export = chats.read_export

    def counting_read_export(path):
        read_calls.append(path)
        return original_read_export(path)

    monkeypatch.setattr(chats, "read_export", counting_read_export)

    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
        "background": True,
    })

    status, payload = responses[-1]
    assert status == 202, payload
    job_id = payload["job"]["id"]
    assert payload["job"]["status"] == "running"

    # Wait until the worker thread is actively inside a file transfer.
    for _ in range(100):
        if entered.is_set():
            break
        await asyncio.sleep(0.02)
    assert entered.is_set()

    # The server stays responsive while the download is blocked in its worker:
    # job status reports running, remote-projects marks it as downloading,
    # duplicate clones are refused with 409, and active jobs cannot be dismissed.
    await call_get(server, "/api/cloud/clone/jobs")
    status, jobs_payload = responses[-1]
    assert status == 200
    assert len(jobs_payload["jobs"]) == 1
    assert jobs_payload["jobs"][0]["id"] == job_id
    assert jobs_payload["jobs"][0]["status"] == "running"

    await call(server, "/api/cloud/remote-projects", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
    })
    status, remote_payload = responses[-1]
    assert status == 200
    assert remote_payload["projects"][0]["downloading"] is True

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis-copy",
        "background": True,
    })
    assert responses[-1][0] == 409

    await call(server, "/api/cloud/clone/dismiss", {"id": job_id})
    assert responses[-1][0] == 400

    # Let the transfer finish and await the background task.
    release.set()
    task = server._clone_tasks.get(job_id)
    if task is not None:
        await task

    await call_get(server, "/api/cloud/clone/jobs")
    status, jobs_payload = responses[-1]
    assert status == 200
    finished = jobs_payload["jobs"][0]
    assert finished["status"] == "completed", finished
    assert finished["project"]["project_name"] == "thesis"
    assert finished["project"]["chats_import_error"] == ""
    assert read(finished["project"]["project_path"], "main.tex") == "\\section{Intro}"

    # Conversations and settings arrived, and chats.json was parsed only once.
    store = ProjectStore(db_path)
    loaded = store.load(finished["project"]["name"])
    assert any(m["content"] == "a question I asked on machine A" for m in loaded.history)
    assert loaded.description == "written on machine A"
    assert len(read_calls) == 1

    # Once finished, the job entry can be dismissed.
    await call(server, "/api/cloud/clone/dismiss", {"id": job_id})
    assert responses[-1] == (200, {"dismissed": True})
    await call_get(server, "/api/cloud/clone/jobs")
    assert responses[-1] == (200, {"jobs": []})


@pytest.mark.asyncio
async def test_background_clone_can_be_cancelled_and_cleans_up(
    tmp_path, remote_base, monkeypatch
):
    import asyncio
    import threading

    seed_remote(remote_base, "thesis", {
        f"file{i:02d}.tex": f"content {i}" for i in range(4)
    })
    db_path = str(tmp_path / "machine-b.db")
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    parent = tmp_path / "projects"
    parent.mkdir()
    destination = str(parent / "thesis")

    first_started = threading.Event()
    release_first = threading.Event()
    original_download = LocalFolderProvider.download
    calls = []

    def gated_download(self, *args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            first_started.set()
            assert release_first.wait(timeout=5.0)
        return original_download(self, *args, **kwargs)

    monkeypatch.setattr(LocalFolderProvider, "download", gated_download)
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
        "background": True,
    })
    assert responses[-1][0] == 202
    job_id = responses[-1][1]["job"]["id"]

    for _ in range(100):
        if first_started.is_set():
            break
        await asyncio.sleep(0.02)
    assert first_started.is_set()

    await call(server, "/api/cloud/cancel", {"projectPath": destination})
    assert responses[-1] == (200, {"cancel_requested": True})

    release_first.set()
    task = server._clone_tasks.get(job_id)
    if task is not None:
        await task

    await call_get(server, "/api/cloud/clone/jobs")
    finished = responses[-1][1]["jobs"][0]
    assert finished["status"] == "cancelled"
    assert finished["partial_copy_removed"] is True
    assert not os.path.exists(destination)
    assert ProjectStore(db_path).find_by_path(destination) is None


@pytest.mark.asyncio
async def test_background_clone_validates_synchronously_before_queuing(
    tmp_path, remote_base, monkeypatch
):
    seed_remote(remote_base, "thesis", {"main.tex": "body"})
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", str(tmp_path / "machine-b.db"))
    non_empty = tmp_path / "projects" / "thesis"
    non_empty.mkdir(parents=True)
    write(str(non_empty), "existing.tex", "already here")
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(tmp_path / "projects"),
        "folderName": "thesis",
        "background": True,
    })

    assert responses[-1][0] == 400
    assert "not empty" in responses[-1][1]["error"]
    await call_get(server, "/api/cloud/clone/jobs")
    assert responses[-1] == (200, {"jobs": []})


@pytest.mark.asyncio
async def test_background_clone_honours_a_cancel_sent_before_the_transfer_registered(
    tmp_path, remote_base, monkeypatch
):
    """A cancel that `request_cancel` could not flag yet must not be lost."""
    import asyncio
    import threading

    from opalatex.cloud import service as cloud_service

    seed_remote(remote_base, "thesis", {"main.tex": "body"})
    db_path = str(tmp_path / "machine-b.db")
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    parent = tmp_path / "projects"
    parent.mkdir()
    destination = str(parent / "thesis")

    reached = threading.Event()
    release = threading.Event()
    original_begin = cloud_service._begin_progress

    def gated_begin(project_path, dry_run):
        reached.set()
        assert release.wait(timeout=5.0)
        return original_begin(project_path, dry_run)

    monkeypatch.setattr(cloud_service, "_begin_progress", gated_begin)
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
        "background": True,
    })
    assert responses[-1][0] == 202
    job_id = responses[-1][1]["job"]["id"]

    for _ in range(100):
        if reached.is_set():
            break
        await asyncio.sleep(0.02)
    assert reached.is_set()

    # Nothing is registered under the destination yet, so only the job flag
    # can carry this request.
    await call(server, "/api/cloud/cancel", {"projectPath": destination})
    assert responses[-1] == (200, {"cancel_requested": True})

    release.set()
    task = server._clone_tasks.get(job_id)
    if task is not None:
        await task

    await call_get(server, "/api/cloud/clone/jobs")
    finished = responses[-1][1]["jobs"][0]
    assert finished["status"] == "cancelled", finished
    assert finished["partial_copy_removed"] is True
    assert not os.path.exists(destination)
    assert ProjectStore(db_path).find_by_path(destination) is None


@pytest.mark.asyncio
async def test_a_failed_conversation_import_is_reported_not_just_printed(
    tmp_path, remote_base, monkeypatch
):
    """The download still completes, but the job says the history did not arrive."""
    import sqlite3

    source_machine(tmp_path, remote_base, monkeypatch)
    db_path = str(tmp_path / "machine-b" / "sessions.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    monkeypatch.setattr("opalatex.config.DEFAULT_DB_PATH", db_path)
    monkeypatch.setattr(chats, "_default_db_path", lambda: db_path)
    parent = tmp_path / "machine-b" / "projects"
    parent.mkdir(parents=True)

    def locked(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(chats, "merge_into_database", locked)
    server, responses = make_server()

    await call(server, "/api/cloud/clone", {
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
        "background": True,
    })
    assert responses[-1][0] == 202
    job_id = responses[-1][1]["job"]["id"]
    task = server._clone_tasks.get(job_id)
    if task is not None:
        await task

    await call_get(server, "/api/cloud/clone/jobs")
    finished = responses[-1][1]["jobs"][0]
    assert finished["status"] == "completed", finished
    assert finished["project"]["chats_import_error"] == "database is locked"
    # The files and the registration are kept; only the history is missing.
    assert read(finished["project"]["project_path"], "main.tex") == "\\section{Intro}"
    assert ProjectStore(db_path).find_by_path(finished["project"]["project_path"])
