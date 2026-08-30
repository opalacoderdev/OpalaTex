"""Make a project's conversations part of the synced project.

A project's files live in its directory, but its chats, message history, agent
activity and per-chat memory live in ``~/.opalatex/sessions.db`` — a single
SQLite database shared by *every* project on the machine. That database cannot
be mirrored as-is: it would copy unrelated projects' conversations into this
project's cloud folder, and reconciling two machines' copies of a WAL-mode
SQLite file is not something a file-level sync can do safely.

So the rows belonging to one project are exported to a portable JSON document
inside the project (``.opalatex/session/chats.json``), which syncs like any
other file, and merged back on the way in.

Merge policy
------------
Conversation data is append-mostly, so the merge is a union keyed by content:
messages and activity present on either side survive. Deletions therefore do not
propagate — a chat cleared on one machine comes back from the other. That is the
deliberate trade: for a history the user cannot reconstruct, resurrecting a
message is a nuisance while dropping one is data loss.

Project-level settings use row-level last-writer-wins on ``updated_at``. Fields
that only make sense on one machine — the project's path, its git root — are
never exported.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from dataclasses import dataclass, field
from typing import Any, Optional

from .state import CHATS_EXPORT_REL_PATH

# Columns of `projects` that describe the work rather than the machine. The
# path columns are excluded on purpose: importing them would point a project at
# a directory that does not exist here.
PORTABLE_PROJECT_FIELDS = (
    "description",
    "core_memory",
    "main_file",
    "mode",
    "model",
    "worker_model",
    "model_params",
    "worker_model_params",
    "use_shared_memory",
    "compile_on_save_partial",
    "compile_on_save_full",
)

EXPORT_VERSION = 1


@dataclass
class MergeStats:
    chats_added: int = 0
    messages_added: int = 0
    activity_added: int = 0
    settings_applied: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "chats_added": self.chats_added,
            "messages_added": self.messages_added,
            "activity_added": self.activity_added,
            "settings_applied": self.settings_applied,
            "notes": self.notes,
        }

    @property
    def changed(self) -> bool:
        return bool(
            self.chats_added or self.messages_added or self.activity_added or self.settings_applied
        )


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _default_db_path() -> str:
    from ..config import DEFAULT_DB_PATH

    return DEFAULT_DB_PATH


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Read a table's actual columns.

    The schema grows by additive migrations, and a database written by an older
    build will be missing the newest ones. Selecting explicitly-named columns
    that may not exist yet would make the export fail on exactly the machine
    most likely to be syncing for the first time.
    """
    try:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _message_key(row: dict[str, Any]) -> str:
    """Stable identity for one message.

    ``client_message_id`` is authoritative when present — the front-end already
    uses it to deduplicate. Otherwise the content itself is the key, so replaying
    the same export twice cannot double a conversation.
    """
    client_id = str(row.get("client_message_id", "") or "")
    if client_id:
        return f"cid:{client_id}"
    digest = hashlib.sha256()
    for field_name in ("chat_id", "timestamp", "role", "content", "attachments"):
        digest.update(str(row.get(field_name, "")).encode("utf-8", "replace"))
        digest.update(b"\x1f")
    return f"h:{digest.hexdigest()}"


def _activity_key(row: dict[str, Any]) -> str:
    digest = hashlib.sha256()
    for field_name in ("chat_id", "timestamp", "event", "agent", "content", "payload"):
        digest.update(str(row.get(field_name, "")).encode("utf-8", "replace"))
        digest.update(b"\x1f")
    return digest.hexdigest()


# ─── Export ───────────────────────────────────────────────────────────────────

def export_project(project_name: str, db_path: Optional[str] = None) -> dict[str, Any]:
    """Build the portable document for one project.

    The output is deterministic: rows are sorted and the machine-local
    autoincrement ids are dropped. An unchanged conversation therefore produces
    byte-identical JSON, so the sync engine sees no change and uploads nothing.
    """
    path = db_path or _default_db_path()
    if not os.path.isfile(path):
        return {"version": EXPORT_VERSION, "project": project_name, "chats": [], "messages": [], "activity": []}

    with _connect(path) as conn:
        project_columns = _columns(conn, "projects")
        settings: dict[str, Any] = {}
        updated_at = ""
        if project_columns:
            row = conn.execute(
                "SELECT * FROM projects WHERE name = ?", (project_name,)
            ).fetchone()
            if row is not None:
                updated_at = str(row["updated_at"] if "updated_at" in row.keys() else "")
                settings = {
                    field_name: row[field_name]
                    for field_name in PORTABLE_PROJECT_FIELDS
                    if field_name in project_columns
                }

        chat_columns = _columns(conn, "project_chats")
        chats = []
        if chat_columns:
            wanted = [c for c in ("id", "name", "created_at", "core_memory", "agent_state", "context_usage") if c in chat_columns]
            for row in conn.execute(
                f"SELECT {', '.join(wanted)} FROM project_chats WHERE project = ? ORDER BY id",
                (project_name,),
            ):
                chats.append({key: row[key] for key in wanted})

        history_columns = _columns(conn, "project_history")
        messages = []
        if history_columns:
            wanted = [
                c
                for c in (
                    "chat_id", "timestamp", "role", "content", "client_message_id",
                    "attachments", "deleted_at", "superseded_by",
                )
                if c in history_columns
            ]
            for row in conn.execute(
                f"SELECT {', '.join(wanted)} FROM project_history WHERE project = ? ORDER BY id",
                (project_name,),
            ):
                messages.append({key: row[key] for key in wanted})

        activity_columns = _columns(conn, "project_activity")
        activity = []
        if activity_columns:
            wanted = [
                c
                for c in ("chat_id", "timestamp", "event", "agent", "content", "payload", "deleted_at")
                if c in activity_columns
            ]
            for row in conn.execute(
                f"SELECT {', '.join(wanted)} FROM project_activity WHERE project = ? ORDER BY id",
                (project_name,),
            ):
                activity.append({key: row[key] for key in wanted})

    messages.sort(key=lambda row: (str(row.get("chat_id", "")), str(row.get("timestamp", "")), _message_key(row)))
    activity.sort(key=lambda row: (str(row.get("chat_id", "")), str(row.get("timestamp", "")), _activity_key(row)))
    chats.sort(key=lambda row: str(row.get("id", "")))

    return {
        "version": EXPORT_VERSION,
        "project": project_name,
        "updated_at": updated_at,
        "settings": settings,
        "chats": chats,
        "messages": messages,
        "activity": activity,
    }


def export_path(project_path: str) -> str:
    return os.path.join(os.path.abspath(project_path), *CHATS_EXPORT_REL_PATH.split("/"))


def write_export(project_path: str, payload: dict[str, Any]) -> bool:
    """Write the export, returning True only when the bytes actually changed.

    Rewriting an identical file would bump its mtime, and the scanner would then
    re-hash and re-upload a document that says exactly what the remote already
    holds — on every single sync pass.
    """
    target = export_path(project_path)
    serialized = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)
    try:
        with open(target, "r", encoding="utf-8") as handle:
            if handle.read() == serialized:
                return False
    except (FileNotFoundError, OSError):
        pass

    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".chats-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, target)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise
    return True


def read_export(project_path: str) -> Optional[dict[str, Any]]:
    return read_export_from(export_path(project_path))


def read_export_from(path: str) -> Optional[dict[str, Any]]:
    """Read an export document from an explicit path.

    Used for the copy a conflict parks beside the canonical file, which holds
    the other machine's history and has to be merged from where it landed.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return payload if isinstance(payload, dict) else None


# ─── Import ───────────────────────────────────────────────────────────────────

def merge_into_database(
    project_name: str, payload: dict[str, Any], db_path: Optional[str] = None
) -> MergeStats:
    """Merge a document produced by :func:`export_project` into the local store."""
    stats = MergeStats()
    if not isinstance(payload, dict):
        return stats
    version = int(payload.get("version", 0) or 0)
    if version > EXPORT_VERSION:
        stats.notes.append(
            f"The synced conversation file was written by a newer OpalaTex "
            f"(format {version}); it was left untouched."
        )
        return stats

    path = db_path or _default_db_path()
    if not os.path.isfile(path):
        return stats

    with _connect(path) as conn:
        exists = conn.execute(
            "SELECT updated_at FROM projects WHERE name = ?", (project_name,)
        ).fetchone()
        if exists is None:
            # The project row is created by ProjectStore when the project is
            # opened. Writing history for a project that does not exist locally
            # would violate the foreign key and orphan the rows.
            stats.notes.append("The project does not exist in this installation yet.")
            return stats

        stats.chats_added = _merge_chats(conn, project_name, payload.get("chats") or [])
        stats.messages_added = _merge_messages(conn, project_name, payload.get("messages") or [])
        stats.activity_added = _merge_activity(conn, project_name, payload.get("activity") or [])
        stats.settings_applied = _merge_settings(
            conn,
            project_name,
            payload.get("settings") or {},
            str(payload.get("updated_at", "") or ""),
            str(exists["updated_at"] or ""),
        )
        conn.commit()
    return stats


def _merge_chats(conn: sqlite3.Connection, project_name: str, chats: list) -> int:
    columns = _columns(conn, "project_chats")
    if not columns:
        return 0
    known = {
        str(row["id"])
        for row in conn.execute("SELECT id FROM project_chats WHERE project = ?", (project_name,))
    }
    added = 0
    for chat in chats:
        if not isinstance(chat, dict):
            continue
        chat_id = str(chat.get("id", "") or "")
        if not chat_id or chat_id in known:
            # An existing chat keeps this machine's row. Its messages still
            # merge below; only the chat's own metadata is left alone, because
            # core memory and agent state are working state that a blind
            # overwrite could roll back mid-conversation.
            continue
        fields = {key: chat.get(key) for key in chat if key in columns}
        fields["id"] = chat_id
        fields["project"] = project_name
        fields.setdefault("name", chat_id)
        fields.setdefault("created_at", "")
        names = sorted(fields)
        conn.execute(
            f"INSERT OR IGNORE INTO project_chats ({', '.join(names)}) "
            f"VALUES ({', '.join('?' for _ in names)})",
            [fields[name] for name in names],
        )
        known.add(chat_id)
        added += 1
    return added


def _merge_messages(conn: sqlite3.Connection, project_name: str, messages: list) -> int:
    columns = _columns(conn, "project_history")
    if not columns:
        return 0
    existing_keys = set()
    wanted = [c for c in ("chat_id", "timestamp", "role", "content", "client_message_id", "attachments") if c in columns]
    for row in conn.execute(
        f"SELECT {', '.join(wanted)} FROM project_history WHERE project = ?", (project_name,)
    ):
        existing_keys.add(_message_key({key: row[key] for key in wanted}))

    valid_chats = {
        str(row["id"])
        for row in conn.execute("SELECT id FROM project_chats WHERE project = ?", (project_name,))
    }

    added = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        key = _message_key(message)
        if key in existing_keys:
            continue
        chat_id = str(message.get("chat_id", "") or "")
        if chat_id and valid_chats and chat_id not in valid_chats:
            # The message belongs to a chat this machine does not have and the
            # export did not carry. Inserting it would hide it from every chat.
            continue
        fields = {name: message.get(name) for name in message if name in columns}
        fields["project"] = project_name
        names = sorted(fields)
        conn.execute(
            f"INSERT OR IGNORE INTO project_history ({', '.join(names)}) "
            f"VALUES ({', '.join('?' for _ in names)})",
            [fields[name] for name in names],
        )
        existing_keys.add(key)
        added += 1
    return added


def _merge_activity(conn: sqlite3.Connection, project_name: str, activity: list) -> int:
    columns = _columns(conn, "project_activity")
    if not columns:
        return 0
    wanted = [c for c in ("chat_id", "timestamp", "event", "agent", "content", "payload") if c in columns]
    existing_keys = {
        _activity_key({key: row[key] for key in wanted})
        for row in conn.execute(
            f"SELECT {', '.join(wanted)} FROM project_activity WHERE project = ?", (project_name,)
        )
    }
    added = 0
    for item in activity:
        if not isinstance(item, dict):
            continue
        key = _activity_key(item)
        if key in existing_keys:
            continue
        fields = {name: item.get(name) for name in item if name in columns}
        fields["project"] = project_name
        names = sorted(fields)
        conn.execute(
            f"INSERT OR IGNORE INTO project_activity ({', '.join(names)}) "
            f"VALUES ({', '.join('?' for _ in names)})",
            [fields[name] for name in names],
        )
        existing_keys.add(key)
        added += 1
    return added


def _merge_settings(
    conn: sqlite3.Connection,
    project_name: str,
    settings: dict,
    incoming_updated_at: str,
    local_updated_at: str,
) -> bool:
    """Apply portable project settings when the incoming row is the newer one."""
    if not settings or not incoming_updated_at:
        return False
    # String comparison is correct here: every writer stores ISO-8601 UTC
    # timestamps, which sort chronologically as text.
    if local_updated_at and incoming_updated_at <= local_updated_at:
        return False
    columns = _columns(conn, "projects")
    applicable = {
        name: value
        for name, value in settings.items()
        if name in PORTABLE_PROJECT_FIELDS and name in columns
    }
    if not applicable:
        return False
    names = sorted(applicable)
    conn.execute(
        f"UPDATE projects SET {', '.join(f'{name} = ?' for name in names)} WHERE name = ?",
        [applicable[name] for name in names] + [project_name],
    )
    return True


# ─── Convenience wrappers used by the sync service ────────────────────────────

def refresh_export(project_name: str, project_path: str, db_path: Optional[str] = None) -> bool:
    """Regenerate the on-disk export. True when the file changed."""
    return write_export(project_path, export_project(project_name, db_path))


def apply_export(project_name: str, project_path: str, db_path: Optional[str] = None) -> MergeStats:
    """Merge whatever the on-disk export holds back into the local database."""
    payload = read_export(project_path)
    if payload is None:
        return MergeStats()
    return merge_into_database(project_name, payload, db_path)
