"""Project management: create, load, save, and list OpalaTex projects using SQLite."""

import sqlite3
import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

from .config import DEFAULT_DB_PATH, DEFAULT_MODEL, resolve_display_num_ctx
from .api_keys import get_env_var_for_model


_LEGACY_CLOUD_MODEL_ALIASES = {"OpalaTexCloud", "OpalaTexCloudGemini35Flash"}


def _available_project_model(model: str | None) -> str:
    """Fall back to the default model for projects that still store a
    discontinued Opala Cloud model alias from before the Cloud service was
    removed."""
    value = str(model or "")
    if value in _LEGACY_CLOUD_MODEL_ALIASES:
        return DEFAULT_MODEL
    return value


def _env_base_var_for_model(model: str) -> str:
    key_var = get_env_var_for_model(model or "")
    if key_var.endswith("_API_KEY"):
        return key_var[:-len("_API_KEY")] + "_API_BASE"
    return ""


def _read_env_values(path: str) -> dict[str, str]:
    values = {}
    if not os.path.isfile(path):
        return values
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except Exception:
        pass
    return values


def _first_env_value(values: dict[str, str], names: list[str]) -> str:
    for name in names:
        if name and values.get(name, "") != "":
            return values[name]
    return ""


def _api_credential_names(model: str) -> tuple[str, str]:
    return get_env_var_for_model(model or ""), _env_base_var_for_model(model or "")


def _ensure_dir(path: str) -> None:
    if path == ":memory:":
        return
    dirname = os.path.dirname(path)
    if dirname:
        os.makedirs(dirname, exist_ok=True)


def _conn(db_path: str) -> sqlite3.Connection:
    _ensure_dir(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    if db_path != ":memory:":
        # WAL + NORMAL avoid an fsync-on-commit on every write. Each ProjectStore
        # method opens a fresh connection (see call sites below), so with the
        # default DELETE journal mode every insert/update paid a full disk sync;
        # under high-frequency callers (e.g. per-token activity logging during
        # streaming) that was enough to stall the async event loop.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_compile_on_save(partial: bool, full: bool) -> tuple[bool, bool]:
    """Keep compile-on-save mode mutually exclusive; both false means disabled."""
    if full:
        return False, True
    if partial:
        return True, False
    return False, False


MAIN_CHAT_NAME = "Main Chat"

# The default `project_history.chat_id` and `project_activity.chat_id` were
# created with, back when a project had exactly one conversation. No chat is
# ever stored under this id — the default chat is `main_<project>` — so rows
# still carrying it belong to no chat. See `_migrate_legacy_main_chat_rows`.
LEGACY_MAIN_CHAT_ID = "main"


def main_chat_id(project_name: str) -> str:
    """The id of a project's default chat.

    There is no chat whose id is the literal ``"main"``: the default chat is
    created as ``main_<project>``. Callers must resolve the id through this
    helper instead of hardcoding a sentinel that matches no stored row.
    """
    return f"main_{project_name}"


TUTORIAL_CHAT_NAME = "Tutorial"


def tutorial_chat_id(project_name: str) -> str:
    """The id of a project's built-in tutorial chat.

    Reserved like ``main_<project>`` so the tutorial button always reopens the same
    conversation instead of piling up a new chat per click, and so the orchestrator can
    tell it apart when deciding whether to load the usage guide into its system prompt.
    The chat is otherwise ordinary: it can be renamed and deleted, and reopening the
    tutorial recreates it.
    """
    return f"tutorial_{project_name}"


def _migrate_legacy_main_chat_rows(conn) -> int:
    """Reattach pre-multi-chat rows to the project's real main chat.

    ``chat_id`` was added to ``project_history`` and ``project_activity`` with
    ``DEFAULT 'main'`` and never backfilled, so every message written before
    multi-chat support points at an id no ``project_chats`` row carries. Each
    read path scopes by a real chat id, which left those conversations stored
    but unreachable. Returns how many rows were moved.

    Only the legacy sentinel is remapped. An unrecognised id from some other
    source is not evidence that its rows belong to the main chat, and merging
    them there would fabricate a history the user never had.
    """
    moved = 0
    project_names = [r["name"] for r in conn.execute("SELECT name, created_at FROM projects").fetchall()]
    for name in project_names:
        # A project that genuinely owns a chat with this id is not a legacy
        # project: its rows belong to that chat and must be left alone.
        if conn.execute(
            "SELECT 1 FROM project_chats WHERE project = ? AND id = ?",
            (name, LEGACY_MAIN_CHAT_ID),
        ).fetchone():
            continue

        orphan_count = conn.execute(
            """
            SELECT (SELECT COUNT(*) FROM project_history  WHERE project = ? AND chat_id = ?)
                 + (SELECT COUNT(*) FROM project_activity WHERE project = ? AND chat_id = ?)
            """,
            (name, LEGACY_MAIN_CHAT_ID, name, LEGACY_MAIN_CHAT_ID),
        ).fetchone()[0]
        if not orphan_count:
            continue

        target_id = main_chat_id(name)
        if not conn.execute(
            "SELECT 1 FROM project_chats WHERE project = ? AND id = ?", (name, target_id)
        ).fetchone():
            # An older build could delete the main chat (the guard compared
            # against the sentinel, which matched nothing). Recreate it with the
            # project's own creation time so it still sorts first in the list.
            created_at = conn.execute(
                "SELECT created_at FROM projects WHERE name = ?", (name,)
            ).fetchone()["created_at"]
            conn.execute(
                "INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (target_id, name, MAIN_CHAT_NAME, created_at, ""),
            )

        # `idx_project_history_client_message_id` is unique per (project, chat,
        # client_message_id). A legacy row whose id already exists in the target
        # chat would abort the move, so drop the duplicate marker rather than the
        # message: the id only deduplicates in-flight sends, and these are done.
        conn.execute(
            """
            UPDATE project_history SET client_message_id = ''
            WHERE project = ? AND chat_id = ? AND client_message_id != ''
              AND EXISTS (
                  SELECT 1 FROM project_history AS target
                  WHERE target.project = ? AND target.chat_id = ?
                    AND target.client_message_id = project_history.client_message_id
              )
            """,
            (name, LEGACY_MAIN_CHAT_ID, name, target_id),
        )

        conn.execute(
            "UPDATE project_history SET chat_id = ? WHERE project = ? AND chat_id = ?",
            (target_id, name, LEGACY_MAIN_CHAT_ID),
        )
        conn.execute(
            "UPDATE project_activity SET chat_id = ? WHERE project = ? AND chat_id = ?",
            (target_id, name, LEGACY_MAIN_CHAT_ID),
        )
        moved += orphan_count

    return moved


def _init_schema(db_path: str) -> None:
    with _conn(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                name            TEXT PRIMARY KEY,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL,
                mode            TEXT NOT NULL DEFAULT 'plan',
                model           TEXT NOT NULL DEFAULT '',
                project_name    TEXT NOT NULL DEFAULT '',
                project_path    TEXT NOT NULL DEFAULT '',
                skills          TEXT NOT NULL DEFAULT '["opalatex"]',
                description     TEXT NOT NULL DEFAULT '',
                request         TEXT NOT NULL DEFAULT '',
                plan_text       TEXT NOT NULL DEFAULT '',
                subplans        TEXT NOT NULL DEFAULT '[]',
                results         TEXT NOT NULL DEFAULT '{}',
                core_memory     TEXT NOT NULL DEFAULT '',
                worker_model    TEXT NOT NULL DEFAULT '',
                model_params    TEXT NOT NULL DEFAULT '{}',
                main_file       TEXT NOT NULL DEFAULT '',
                git_root_path   TEXT NOT NULL DEFAULT '',
                compile_on_save_partial INTEGER NOT NULL DEFAULT 1,
                compile_on_save_full INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS project_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project     TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                role        TEXT NOT NULL,
                content     TEXT NOT NULL,
                client_message_id TEXT NOT NULL DEFAULT '',
                attachments TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_activity (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project     TEXT NOT NULL,
                chat_id     TEXT NOT NULL DEFAULT 'main',
                timestamp   TEXT NOT NULL,
                event       TEXT NOT NULL,
                agent       TEXT NOT NULL DEFAULT '',
                content     TEXT NOT NULL DEFAULT '',
                payload     TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
            );
        """)
        
        # Migração: tentar adicionar core_memory caso não exista
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN core_memory TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        # Migração: modelo do worker por projeto
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN worker_model TEXT NOT NULL DEFAULT ''")
            try:
                conn.execute("UPDATE projects SET worker_model = alternative_model WHERE alternative_model != ''")
            except sqlite3.OperationalError:
                pass
        except sqlite3.OperationalError:
            pass

        # Migração: model_params
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN model_params TEXT NOT NULL DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass

        # Migração: Multi-Chat support
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN use_shared_memory INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass

        # Migração: worker_model_params
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN worker_model_params TEXT NOT NULL DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass

        # Migração: main_file
        try:
            conn.execute("ALTER TABLE projects ADD COLUMN main_file TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE projects ADD COLUMN git_root_path TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE projects ADD COLUMN compile_on_save_partial INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE projects ADD COLUMN compile_on_save_full INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS project_chats (
                id          TEXT PRIMARY KEY,
                project     TEXT NOT NULL,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                core_memory TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
            );
        """)

        # Per-chat MemGPT working state (internal history + recursive summary), so the
        # orchestrator's context management survives turns and restarts instead of
        # being rebuilt from a raw slice of the chat every time.
        try:
            conn.execute("ALTER TABLE project_chats ADD COLUMN agent_state TEXT NOT NULL DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass

        # Last measured occupancy of the chat's context window. It belongs next to
        # the working state it describes: the state survives a chat switch or a
        # restart, so the indicator built from it must survive them too, instead of
        # falling back to the character estimate over a conversation the agent will
        # replay in full on the next turn.
        try:
            conn.execute("ALTER TABLE project_chats ADD COLUMN context_usage TEXT NOT NULL DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'main'")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN client_message_id TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        # Soft delete: editing a message hides the superseded tail from the chat
        # and from the model, but never destroys it. Physical deletion is reserved
        # for explicit user actions (clear chat, delete project).
        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_activity ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_project_history_client_message_id
            ON project_history(project, chat_id, client_message_id)
            WHERE client_message_id != ''
            """
        )

        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_project_activity_chat
            ON project_activity(project, chat_id, id)
            """
        )

        # Runs after the indexes exist, so the move honours them. Idempotent:
        # once the rows carry a real chat id there is nothing left to match.
        moved = _migrate_legacy_main_chat_rows(conn)
        if moved:
            print(
                f"[opalatex] Reattached {moved} pre-multi-chat row(s) to their project's main chat.",
                file=sys.stderr,
            )


class ChatNotFoundError(ValueError):
    """Raised when a caller asks for a chat that does not exist in a project.

    Silently answering with a different chat is what made a stale id look like
    a working one: the selector showed one chat while the history came from
    another. An unknown id is a bug in the caller, so it fails loudly.
    """


@dataclass
class ProjectData:
    name: str
    use_shared_memory: bool = False
    chats: list = field(default_factory=list)
    current_chat_id: str = ""
    mode: str = "plan"
    model: str = ""
    worker_model: str = ""   # "" → falls back to the project.model
    project_name: str = ""
    project_path: str = ""
    skills: list = field(default_factory=lambda: ["opalatex"])
    description: str = ""
    request: str = ""
    plan_text: str = ""
    subplans: list = field(default_factory=list)
    results: dict = field(default_factory=dict)
    core_memory: str = ""
    model_params: dict = field(default_factory=lambda: {"think": False, "stream": True})
    worker_model_params: dict = field(default_factory=lambda: {"think": False, "stream": True})
    api_key: str = ""
    api_base: str = ""
    worker_api_key: str = ""
    worker_api_base: str = ""
    main_file: str = ""
    git_root_path: str = ""
    compile_on_save_partial: bool = True
    compile_on_save_full: bool = False
    history: list = field(default_factory=list)   # [{role, content}]

    def __post_init__(self) -> None:
        # Everything scoped per chat (archival memory, core memory, context
        # measurement) keys off this id, so it must always name a real chat.
        if not self.current_chat_id:
            self.current_chat_id = main_chat_id(self.name)

    def clear_state(self) -> None:
        self.request = ""
        self.plan_text = ""
        self.subplans = []
        self.results = {}

    def context_header(self) -> str:
        """Returns a project context string to prepend to every prompt."""
        name = self.project_name or self.name
        path = self.project_path or "(unspecified)"
        return f"[PROJECT: {name} | PATH: {path}]\n"


# Backward-compat alias so existing imports of SessionData still work during migration
SessionData = ProjectData


class ProjectStore:
    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = db_path
        self._activity_local = threading.local()
        _init_schema(db_path)

    def _activity_conn(self) -> sqlite3.Connection:
        """Reused connection for the per-token activity write path.

        `append_activity` runs once per streamed token, on the server's single
        event loop thread. Opening a fresh connection there measured ~13 ms per
        call — not the fsync (WAL already removed that), but the PRAGMAs plus the
        WAL index every new connection has to re-open before it can commit. At
        800 chunks that is ~10 s of blocked event loop per response, which is
        what stalled unrelated requests such as opening a file in the editor.
        Reusing the connection measures ~0.03 ms. This is the only call site that
        may keep a connection: it is a single-statement INSERT that never nests
        inside another `_conn()` transaction, so a shared connection cannot
        commit an enclosing one early. Every other call site still opens per call.
        The connection is thread-local because sqlite3 forbids sharing one across
        threads, and tool calls reach the store from worker threads.
        """
        conn = getattr(self._activity_local, "conn", None)
        if conn is None:
            conn = _conn(self.db_path)
            self._activity_local.conn = conn
        return conn

    def close_activity_connection(self) -> None:
        """Release this thread's cached activity connection.

        Kept explicit so a caller that deletes the database file (tests, project
        deletion) can drop the handle first; Windows refuses to unlink a file
        that still has an open handle.
        """
        conn = getattr(self._activity_local, "conn", None)
        if conn is not None:
            self._activity_local.conn = None
            try:
                conn.close()
            except Exception:
                pass

    def exists(self, name: str) -> bool:
        with _conn(self.db_path) as conn:
            row = conn.execute(
                "SELECT 1 FROM projects WHERE name = ?", (name,)
            ).fetchone()
            return row is not None

    def find_by_path(self, path: str) -> str | None:
        with _conn(self.db_path) as conn:
            row = conn.execute(
                "SELECT name FROM projects WHERE project_path = ?", (os.path.abspath(path),)
            ).fetchone()
            return row["name"] if row else None

    def list_projects(self) -> list[dict]:
        with _conn(self.db_path) as conn:
            rows = conn.execute(
                "SELECT name, project_name, project_path, created_at, updated_at, mode, model, worker_model, description, model_params, worker_model_params, use_shared_memory, main_file, git_root_path, compile_on_save_partial, compile_on_save_full FROM projects ORDER BY updated_at DESC"
            ).fetchall()
            res = []
            for r in rows:
                d = dict(r)
                d["model"] = _available_project_model(d.get("model"))
                d["worker_model"] = _available_project_model(d.get("worker_model"))
                d["use_shared_memory"] = bool(d.get("use_shared_memory", True))
                partial, full = _normalize_compile_on_save(
                    bool(d.get("compile_on_save_partial", True)),
                    bool(d.get("compile_on_save_full", False)),
                )
                d["compile_on_save_partial"] = partial
                d["compile_on_save_full"] = full
                
                if "model_params" in d and d["model_params"]:
                    try:
                        d["model_params"] = json.loads(d["model_params"])
                    except Exception:
                        d["model_params"] = {}
                else:
                    d["model_params"] = {}
                    
                if "worker_model_params" in d and d["worker_model_params"]:
                    try:
                        d["worker_model_params"] = json.loads(d["worker_model_params"])
                    except Exception:
                        d["worker_model_params"] = {}
                else:
                    d["worker_model_params"] = {}

                # Fallback worker_model_params to model_params if empty
                if not d["worker_model_params"]:
                    d["worker_model_params"] = dict(d["model_params"])

                # Apply defaults for params added after project creation
                d["model_params"].setdefault("think", False)
                d["model_params"].setdefault("stream", True)
                d["worker_model_params"].setdefault("think", False)
                d["worker_model_params"].setdefault("stream", True)

                # Effective num_ctx for UI display (chat context indicator) before
                # any turn has run to measure the real prompt_tokens window: an
                # explicit override wins, else the model's catalog entry, else the
                # local/cloud heuristic. See config.resolve_display_num_ctx.
                d["effective_num_ctx"] = resolve_display_num_ctx(d.get("model"), d["model_params"])
                
                # Load api_key and api_base from local .env if it exists.
                # Provider-specific names are preferred, with legacy OPENAI_* as fallback.
                d["api_key"] = ""
                d["api_base"] = ""
                d["worker_api_key"] = ""
                d["worker_api_base"] = ""
                proj_path = d.get("project_path")
                if proj_path:
                    abs_proj_path = os.path.expanduser(proj_path)
                    if os.path.isdir(abs_proj_path):
                        env_values = _read_env_values(os.path.join(abs_proj_path, ".env"))
                        key_var, base_var = _api_credential_names(d.get("model", ""))
                        worker_key_var, worker_base_var = _api_credential_names(d.get("worker_model", ""))
                        d["api_key"] = _first_env_value(env_values, [key_var, "OPENAI_API_KEY"])
                        d["api_base"] = _first_env_value(env_values, [base_var, "OPENAI_API_BASE"])
                        d["worker_api_key"] = _first_env_value(env_values, ["WORKER_API_KEY", worker_key_var])
                        d["worker_api_base"] = _first_env_value(env_values, ["WORKER_API_BASE", worker_base_var])
                
                res.append(d)
            return res

    def create(self, name: str, mode: str, model: str, project_name: str = "", project_path: str = "", skills: list = None, description: str = "", worker_model: str = "", api_key: str = None, api_base: str = None, worker_api_key: str = None, worker_api_base: str = None, model_params: dict = None, worker_model_params: dict = None, git_root_path: str = "") -> ProjectData:
        now = datetime.now(timezone.utc).isoformat()
        _skills = skills if skills is not None else ["opalatex"]
        if "opalatex" not in _skills:
            _skills = ["opalatex"] + _skills
        # num_ctx is intentionally NOT defaulted into model_params here: a project
        # created without an explicit override resolves its context window at
        # runtime from the model's catalog entry, then the local/cloud heuristic
        # (see config.resolve_effective_num_ctx). An explicit num_ctx passed in
        # model_params/worker_model_params is preserved as-is and always wins.
        _model_params = dict(model_params or {})
        _model_params.setdefault("stream", True)
        _worker_model_params = dict(worker_model_params or {})

        # Ensure the project path is absolute and exists
        abs_proj_path = os.path.abspath(project_path) if project_path else os.getcwd()
        try:
            os.makedirs(abs_proj_path, exist_ok=True)

            # 1. Initialize command-line skill inside the project's .opalatex/skills/command-line/
            shadow_skill_dir = os.path.join(abs_proj_path, ".opalatex", "skills", "command-line")
            os.makedirs(shadow_skill_dir, exist_ok=True)

            package_dir = os.path.dirname(os.path.abspath(__file__))
            builtin_skill_dir = os.path.join(package_dir, "skills", "command-line")
            if not os.path.isdir(builtin_skill_dir):
                repo_root = os.path.dirname(package_dir)
                builtin_skill_dir = os.path.join(repo_root, "skills", "command-line")

            if os.path.isdir(builtin_skill_dir):
                import shutil
                # Copy SKILL.md
                src_md = os.path.join(builtin_skill_dir, "SKILL.md")
                if os.path.isfile(src_md):
                    shutil.copy2(src_md, os.path.join(shadow_skill_dir, "SKILL.md"))

                # Copy scripts/command_executor.py
                src_script_dir = os.path.join(builtin_skill_dir, "scripts")
                dest_script_dir = os.path.join(shadow_skill_dir, "scripts")
                if os.path.isdir(src_script_dir):
                    os.makedirs(dest_script_dir, exist_ok=True)
                    src_executor = os.path.join(src_script_dir, "command_executor.py")
                    if os.path.isfile(src_executor):
                        shutil.copy2(src_executor, os.path.join(dest_script_dir, "command_executor.py"))

            # 2. Write project's skills.yaml containing the command-line skill
            from .skills import write_skills_yaml
            write_skills_yaml(abs_proj_path, ["command-line"])

            # 3. Write API Key and API Base to local .env
            env_path = os.path.join(abs_proj_path, ".env")
            env_lines = []
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8") as f:
                        env_lines = f.readlines()
                except Exception:
                    pass
            
            def upsert_env(var_name, val):
                if not var_name:
                    return
                for i, line in enumerate(env_lines):
                    if line.strip().startswith(f"{var_name}="):
                        env_lines[i] = f"{var_name}={val}\n"
                        return
                env_lines.append(f"{var_name}={val}\n")

            api_key_var, api_base_var = _api_credential_names(model)
            if api_key:
                upsert_env(api_key_var or "OPENAI_API_KEY", api_key)
            if api_base:
                upsert_env(api_base_var or "OPENAI_API_BASE", api_base)
            if worker_api_key:
                upsert_env("WORKER_API_KEY", worker_api_key)
            if worker_api_base:
                upsert_env("WORKER_API_BASE", worker_api_base)
                
            with open(env_path, "w", encoding="utf-8") as f:
                f.writelines(env_lines)

            # 4. Add .opalatex/ to the project's own .gitignore so OpalaTex
            #    internal files don't appear in the user's git status.
            proj_gitignore = os.path.join(abs_proj_path, ".gitignore")
            opalatex_entry = ".opalatex/"
            try:
                existing = ""
                if os.path.isfile(proj_gitignore):
                    with open(proj_gitignore, "r", encoding="utf-8") as f:
                        existing = f.read()
                if opalatex_entry not in existing:
                    with open(proj_gitignore, "a", encoding="utf-8") as f:
                        if existing and not existing.endswith("\n"):
                            f.write("\n")
                        f.write(f"{opalatex_entry}\n")
            except Exception:
                pass

            # 5. Initialize VCS shadow git
            from .vcs import get_vcs_strategy
            from .config import get_git_strategy
            vcs = get_vcs_strategy(get_git_strategy(), abs_proj_path)
            vcs.setup()
            
            final_api_key_var, final_api_base_var = _api_credential_names(model)
            if api_key:
                upsert_env(final_api_key_var or "OPENAI_API_KEY", api_key)
            if api_base:
                upsert_env(final_api_base_var or "OPENAI_API_BASE", api_base)

            try:
                with open(env_path, "w", encoding="utf-8") as f:

                    f.writelines(env_lines)
            except Exception:
                pass

        except (OSError, PermissionError):
            pass

        with _conn(self.db_path) as conn:
            conn.execute(
                "INSERT INTO projects (name, created_at, updated_at, mode, model, worker_model, project_name, project_path, skills, description, core_memory, model_params, worker_model_params, use_shared_memory, main_file, git_root_path, compile_on_save_partial, compile_on_save_full) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, now, now, mode, model, worker_model, project_name, abs_proj_path, json.dumps(_skills), description, "", json.dumps(_model_params), json.dumps(_worker_model_params), 0, "", os.path.abspath(git_root_path) if git_root_path else "", 1, 0),
            )
            # Create default main chat if it doesn't exist
            chat_id = main_chat_id(name)
            conn.execute(
                "INSERT OR IGNORE INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (chat_id, name, MAIN_CHAT_NAME, now, "")
            )
        return ProjectData(name=name, use_shared_memory=False, chats=[{"id": chat_id, "name": MAIN_CHAT_NAME}], current_chat_id=chat_id, mode=mode, model=model, worker_model=worker_model, project_name=project_name, project_path=abs_proj_path, skills=_skills, description=description, core_memory="", model_params=_model_params, worker_model_params=_worker_model_params, api_key=api_key or "", api_base=api_base or "", worker_api_key=worker_api_key or "", worker_api_base=worker_api_base or "", main_file="", git_root_path=os.path.abspath(git_root_path) if git_root_path else "", compile_on_save_partial=True, compile_on_save_full=False)

    def overwrite(self, name: str, mode: str, model: str, project_name: str = "", project_path: str = "", skills: list = None, description: str = "", worker_model: str = "", api_key: str = None, api_base: str = None, worker_api_key: str = None, worker_api_base: str = None, model_params: dict = None, worker_model_params: dict = None, use_shared_memory: bool = False) -> ProjectData:
        self.delete(name)
        new_proj = self.create(name, mode, model, project_name, project_path, skills, description, worker_model, api_key=api_key, api_base=api_base, worker_api_key=worker_api_key, worker_api_base=worker_api_base, model_params=model_params, worker_model_params=worker_model_params)
        new_proj.use_shared_memory = use_shared_memory
        self.save(new_proj)
        return new_proj

    def delete(self, name: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("DELETE FROM projects WHERE name = ?", (name,))
            conn.execute("DELETE FROM project_history WHERE project = ?", (name,))
        try:
            from .archival import clear_archival
            clear_archival(name)
        except Exception:
            pass

    def rename(self, old_name: str, new_name: str) -> bool:
        if self.exists(new_name):
            return False
        with _conn(self.db_path) as conn:
            row = conn.execute("SELECT * FROM projects WHERE name = ?", (old_name,)).fetchone()
            if row is None:
                return False
            columns = list(row.keys())
            placeholders = ",".join("?" for _ in columns)
            column_sql = ",".join(columns)
            values = [new_name if column == "name" else row[column] for column in columns]
            conn.execute(
                f"INSERT INTO projects ({column_sql}) VALUES ({placeholders})",
                values,
            )
            conn.execute("UPDATE project_chats SET project=? WHERE project=?", (new_name, old_name))
            conn.execute("UPDATE project_history SET project=? WHERE project=?", (new_name, old_name))
            conn.execute("DELETE FROM projects WHERE name=?", (old_name,))
        return True

    def load(self, name: str, chat_id: Optional[str] = None) -> Optional[ProjectData]:
        """Load a project, scoped to one chat.

        ``chat_id=None`` means "the project's default chat" and resolves to the
        main chat. An explicit id that no chat carries raises
        :class:`ChatNotFoundError` rather than quietly returning some other
        chat's history.
        """
        with _conn(self.db_path) as conn:
            row = conn.execute(
                "SELECT * FROM projects WHERE name = ?", (name,)
            ).fetchone()
            if row is None:
                return None

            chats_rows = conn.execute(
                "SELECT id, name FROM project_chats WHERE project = ? ORDER BY created_at ASC", (name,)
            ).fetchall()
            chats = [{"id": r["id"], "name": r["name"]} for r in chats_rows]

            if not chats:
                # A project always owns at least its main chat; repair the row
                # instead of returning a project nothing can be written to.
                repaired_id = main_chat_id(name)
                try:
                    conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (repaired_id, name, MAIN_CHAT_NAME, datetime.now(timezone.utc).isoformat(), ""))
                except sqlite3.IntegrityError:
                    # Fallback if somehow it already exists but wasn't in chats?
                    repaired_id = str(uuid.uuid4())
                    conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (repaired_id, name, MAIN_CHAT_NAME, datetime.now(timezone.utc).isoformat(), ""))
                chats = [{"id": repaired_id, "name": MAIN_CHAT_NAME}]

            if chat_id is None:
                default_id = main_chat_id(name)
                chat_id = default_id if any(c["id"] == default_id for c in chats) else chats[0]["id"]
            elif not any(c["id"] == chat_id for c in chats):
                raise ChatNotFoundError(
                    f"Chat '{chat_id}' does not exist in project '{name}'"
                )


            hist_rows = conn.execute(
                "SELECT id, role, content, timestamp, client_message_id, attachments FROM project_history"
                " WHERE project = ? AND chat_id = ? AND deleted_at = '' ORDER BY id",
                (name, chat_id),
            ).fetchall()
            # Read api_key and api_base from local .env if it exists.
            # Provider-specific names are preferred, with legacy OPENAI_* as fallback.
            api_key = ""
            api_base = ""
            worker_api_key = ""
            worker_api_base = ""
            proj_path = row["project_path"]
            if proj_path and os.path.isdir(proj_path):
                env_values = _read_env_values(os.path.join(proj_path, ".env"))
                model = row["model"]
                worker_model = row["worker_model"] if "worker_model" in row.keys() else ""
                key_var, base_var = _api_credential_names(model)
                worker_key_var, worker_base_var = _api_credential_names(worker_model)
                api_key = _first_env_value(env_values, [key_var, "OPENAI_API_KEY"])
                api_base = _first_env_value(env_values, [base_var, "OPENAI_API_BASE"])
                worker_api_key = _first_env_value(env_values, ["WORKER_API_KEY", worker_key_var])
                worker_api_base = _first_env_value(env_values, ["WORKER_API_BASE", worker_base_var])

            compile_partial, compile_full = _normalize_compile_on_save(
                bool(row["compile_on_save_partial"]) if "compile_on_save_partial" in row.keys() else True,
                bool(row["compile_on_save_full"]) if "compile_on_save_full" in row.keys() else False,
            )

            return ProjectData(
                name=name,
                use_shared_memory=bool(row["use_shared_memory"] if "use_shared_memory" in row.keys() else 1),
                chats=chats,
                current_chat_id=chat_id,
                mode=row["mode"],
                model=_available_project_model(row["model"]),
                worker_model=_available_project_model(row["worker_model"] if "worker_model" in row.keys() else (row["alternative_model"] if "alternative_model" in row.keys() else "")),
                project_name=row["project_name"],
                project_path=row["project_path"],
                skills=json.loads(row["skills"]),
                description=row["description"],
                request=row["request"],
                plan_text=row["plan_text"],
                subplans=json.loads(row["subplans"]),
                results=json.loads(row["results"]),
                core_memory=row["core_memory"] if "core_memory" in row.keys() else "",
                model_params={
                    "think": False, "stream": True,
                    **(json.loads(row["model_params"]) if "model_params" in row.keys() else {}),
                },
                worker_model_params={
                    "think": False, "stream": True,
                    **(json.loads(row["worker_model_params"]) if "worker_model_params" in row.keys() and row["worker_model_params"] else (json.loads(row["model_params"]) if "model_params" in row.keys() else {})),
                },
                api_key=api_key,
                api_base=api_base,
                worker_api_key=worker_api_key,
                worker_api_base=worker_api_base,
                main_file=row["main_file"] if "main_file" in row.keys() else "",
                git_root_path=row["git_root_path"] if "git_root_path" in row.keys() else "",
                compile_on_save_partial=compile_partial,
                compile_on_save_full=compile_full,
                history=[
                    {
                        "id": r["id"],
                        "role": r["role"],
                        "content": r["content"],
                        "timestamp": r["timestamp"],
                        "chat_id": chat_id,
                        "client_message_id": r["client_message_id"] if "client_message_id" in r.keys() else "",
                        "_attachments": json.loads(r["attachments"] or "[]"),
                    }
                    for r in hist_rows
                ],
            )

    def save(self, project: ProjectData) -> None:
        now = datetime.now(timezone.utc).isoformat()
        _skills = list(project.skills)
        if "opalatex" not in _skills:
            _skills = ["opalatex"] + _skills
        _model_params = project.model_params if hasattr(project, "model_params") else {}
        _worker_model_params = project.worker_model_params if hasattr(project, "worker_model_params") and project.worker_model_params else _model_params.copy()
        compile_partial, compile_full = _normalize_compile_on_save(
            bool(getattr(project, "compile_on_save_partial", True)),
            bool(getattr(project, "compile_on_save_full", False)),
        )
        
        # Save api_key and api_base to project's local .env
        if hasattr(project, "api_key") or hasattr(project, "api_base") or hasattr(project, "worker_api_key") or hasattr(project, "worker_api_base"):
            env_path = os.path.join(project.project_path, ".env")
            env_lines = []
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8") as f:
                        env_lines = f.readlines()
                except Exception:
                    pass

            def upsert_env(var_name, val):
                if val is None:
                    return
                if not var_name:
                    return
                for i, line in enumerate(env_lines):
                    if line.strip().startswith(f"{var_name}="):
                        env_lines[i] = f"{var_name}={val}\n"
                        return
                env_lines.append(f"{var_name}={val}\n")

            api_key_var, api_base_var = _api_credential_names(getattr(project, "model", ""))
            upsert_env(api_key_var or "OPENAI_API_KEY", getattr(project, "api_key", ""))
            upsert_env(api_base_var or "OPENAI_API_BASE", getattr(project, "api_base", ""))
            upsert_env("WORKER_API_KEY", getattr(project, "worker_api_key", ""))
            upsert_env("WORKER_API_BASE", getattr(project, "worker_api_base", ""))

            try:
                os.makedirs(project.project_path, exist_ok=True)
                with open(env_path, "w", encoding="utf-8") as f:
                    f.writelines(env_lines)
            except Exception:
                pass

        with _conn(self.db_path) as conn:
            conn.execute(
                """UPDATE projects SET updated_at=?, mode=?, model=?, worker_model=?, project_name=?, project_path=?,
                   skills=?, description=?, request=?, plan_text=?, subplans=?, results=?, core_memory=?, model_params=?, worker_model_params=?, use_shared_memory=?, main_file=?, git_root_path=?, compile_on_save_partial=?, compile_on_save_full=? WHERE name=?""",
                (
                    now,
                    project.mode,
                    project.model,
                    project.worker_model,
                    project.project_name,
                    project.project_path,
                    json.dumps(_skills, ensure_ascii=False),
                    project.description,
                    project.request,
                    project.plan_text,
                    json.dumps(project.subplans, ensure_ascii=False),
                    json.dumps(project.results, ensure_ascii=False),
                    project.core_memory,
                    json.dumps(_model_params, ensure_ascii=False),
                    json.dumps(_worker_model_params, ensure_ascii=False),
                    int(project.use_shared_memory),
                    getattr(project, "main_file", ""),
                    getattr(project, "git_root_path", ""),
                    int(compile_partial),
                    int(compile_full),
                    project.name,
                ),
            )

    def append_message(
        self,
        project: ProjectData,
        role: str,
        content: str,
        attachments: list | None = None,
        client_message_id: str = "",
    ) -> int:
        now = datetime.now(timezone.utc).isoformat()
        message_id = None
        clean_attachments = attachments or []
        clean_client_message_id = str(client_message_id or "").strip()
        with _conn(self.db_path) as conn:
            if clean_client_message_id:
                existing = conn.execute(
                    """
                    SELECT id, role, content, timestamp, attachments
                    FROM project_history
                    WHERE project = ? AND chat_id = ? AND client_message_id = ?
                    """,
                    (project.name, project.current_chat_id, clean_client_message_id),
                ).fetchone()
                if existing:
                    existing_id = int(existing["id"])
                    if not any(int(m.get("id", -1)) == existing_id for m in project.history):
                        existing_message = {
                            "id": existing_id,
                            "role": existing["role"],
                            "content": existing["content"],
                            "timestamp": existing["timestamp"],
                            "client_message_id": clean_client_message_id,
                            "_attachments": json.loads(existing["attachments"] or "[]"),
                        }
                        project.history.append(existing_message)
                    return existing_id

            cursor = conn.execute(
                "INSERT INTO project_history (project, chat_id, timestamp, role, content, client_message_id, attachments) VALUES (?,?,?,?,?,?,?)",
                (
                    project.name,
                    project.current_chat_id,
                    now,
                    role,
                    content,
                    clean_client_message_id,
                    json.dumps(clean_attachments, ensure_ascii=False),
                ),
            )
            message_id = cursor.lastrowid
            
        message = {"id": message_id, "role": role, "content": content, "timestamp": now, "chat_id": project.current_chat_id}
        if clean_client_message_id:
            message["client_message_id"] = clean_client_message_id
        if clean_attachments:
            message["_attachments"] = clean_attachments
        project.history.append(message)
        
        # Envia também para o banco de dados vetorial
        try:
            from .archival import append_to_archival
            append_to_archival(
                project_name=project.name,
                message_id=str(message_id),
                role=role,
                content=content,
                timestamp=now,
                chat_id=project.current_chat_id
            )
        except Exception:
            pass

        return int(message_id)

    def append_activity(
        self,
        project: ProjectData,
        event: str,
        content: str = "",
        agent: str = "",
        payload: dict | None = None,
    ) -> int:
        now = datetime.now(timezone.utc).isoformat()
        clean_payload = payload or {}
        with self._activity_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO project_activity
                (project, chat_id, timestamp, event, agent, content, payload)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    project.name,
                    project.current_chat_id,
                    now,
                    str(event or ""),
                    str(agent or ""),
                    str(content or ""),
                    json.dumps(clean_payload, ensure_ascii=False),
                ),
            )
            return int(cursor.lastrowid)

    def list_activity(self, name: str, chat_id: str, limit: int = 1000) -> list[dict]:
        safe_limit = max(1, int(limit or 1000))
        with _conn(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT id, timestamp, event, agent, content, payload
                FROM project_activity
                WHERE project = ? AND chat_id = ? AND deleted_at = ''
                ORDER BY id DESC
                LIMIT ?
                """,
                (name, chat_id, safe_limit),
            ).fetchall()

        activity = []
        for row in reversed(rows):
            payload = {}
            try:
                payload = json.loads(row["payload"] or "{}")
            except Exception:
                payload = {}
            activity.append({
                "id": row["id"],
                "timestamp": row["timestamp"],
                "event": row["event"],
                "agent": row["agent"],
                "content": row["content"],
                "payload": payload,
            })
        return activity

    def clear_project_history(self, name: str, chat_id: str = None) -> None:
        with _conn(self.db_path) as conn:
            if chat_id:
                conn.execute("DELETE FROM project_history WHERE project = ? AND chat_id = ?", (name, chat_id))
                conn.execute("DELETE FROM project_activity WHERE project = ? AND chat_id = ?", (name, chat_id))
                # The agent's working memory belongs to the conversation that was
                # just erased: keeping it would let the agent recall a chat the
                # user deleted.
                conn.execute(
                    "UPDATE project_chats SET agent_state = '{}', context_usage = '{}' WHERE project = ? AND id = ?",
                    (name, chat_id),
                )
            else:
                conn.execute("DELETE FROM project_history WHERE project = ?", (name,))
                conn.execute("DELETE FROM project_activity WHERE project = ?", (name,))
                conn.execute("UPDATE project_chats SET agent_state = '{}', context_usage = '{}' WHERE project = ?", (name,))

    def clear_all_chats(self, name: str) -> dict:
        """Remove every project chat and recreate an empty main chat."""
        main_chat = {"id": main_chat_id(name), "name": MAIN_CHAT_NAME}
        with _conn(self.db_path) as conn:
            project = conn.execute("SELECT 1 FROM projects WHERE name = ?", (name,)).fetchone()
            if project is None:
                raise ValueError(f"Project '{name}' not found")

            conn.execute("DELETE FROM project_history WHERE project = ?", (name,))
            conn.execute("DELETE FROM project_activity WHERE project = ?", (name,))
            conn.execute("DELETE FROM project_chats WHERE project = ?", (name,))
            conn.execute(
                "INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (main_chat["id"], name, main_chat["name"], datetime.now(timezone.utc).isoformat(), ""),
            )
        return main_chat

    def supersede_chat_history_from_message(
        self,
        name: str,
        chat_id: str,
        *,
        message_id: int | None = None,
        client_message_id: str = "",
        superseded_by: str = "",
    ) -> list[int]:
        """Soft-delete the anchor message and every message after it in the chat.

        The anchor is addressed by stable id (``message_id`` or
        ``client_message_id``), never by position: UI indexes and stored rows do
        not line up (stored audit entries are not rendered, and messages created
        in the running session may not carry a stored id yet), and a positional
        cut silently destroys unrelated turns. An anchor that cannot be resolved
        raises instead of falling back to a position.

        Rows are marked, not deleted: editing a message hides its old answer from
        the chat and from the model, but the conversation stays auditable and
        recoverable. Physical deletion belongs to explicit user actions.
        """
        now = datetime.now(timezone.utc).isoformat()
        clean_superseded_by = str(superseded_by or "").strip()
        with _conn(self.db_path) as conn:
            anchor_id = self._resolve_chat_message_id(
                conn,
                name,
                chat_id,
                message_id=message_id,
                client_message_id=client_message_id,
            )
            if anchor_id is None:
                raise ValueError(
                    "message_id or client_message_id is required to supersede chat history"
                )

            rows = conn.execute(
                """
                SELECT id, timestamp FROM project_history
                WHERE project = ? AND chat_id = ? AND id >= ? AND deleted_at = ''
                ORDER BY id
                """,
                (name, chat_id, anchor_id),
            ).fetchall()
            if not rows:
                return []

            superseded_ids = [int(r["id"]) for r in rows]
            cutoff_timestamp = rows[0]["timestamp"]
            placeholders = ",".join("?" for _ in superseded_ids)
            conn.execute(
                f"""
                UPDATE project_history SET deleted_at = ?, superseded_by = ?
                WHERE project = ? AND chat_id = ? AND id IN ({placeholders})
                """,
                (now, clean_superseded_by, name, chat_id, *superseded_ids),
            )
            conn.execute(
                """
                UPDATE project_activity SET deleted_at = ?
                WHERE project = ? AND chat_id = ? AND timestamp >= ? AND deleted_at = ''
                """,
                (now, name, chat_id, cutoff_timestamp),
            )
            # The agent's working memory still holds the superseded turns. Drop it so
            # the next run re-seeds from the visible conversation instead of replying
            # to a message the user just replaced.
            conn.execute(
                "UPDATE project_chats SET agent_state = '{}', context_usage = '{}' WHERE project = ? AND id = ?",
                (name, chat_id),
            )

        # The vector index is a derived artifact, not the source of truth: drop the
        # superseded entries so archival search stops returning replaced content.
        try:
            from .archival import get_collection
            collection = get_collection(name)
            collection.delete(ids=[str(i) for i in superseded_ids])
        except Exception:
            pass

        return superseded_ids

    def get_chat_core_memory(self, name: str, chat_id: str) -> str:
        with _conn(self.db_path) as conn:
            row = conn.execute("SELECT core_memory FROM project_chats WHERE project = ? AND id = ?", (name, chat_id)).fetchone()
            return row["core_memory"] if row else ""

    def search_chat_content(self, name: str, query: str) -> list[dict]:
        with _conn(self.db_path) as conn:
            # We want to return chats that contain the query string in their history.
            # We will return the chat id, name, and a snippet of the matching content.
            # We group by chat_id to return each chat only once.
            sql = """
                SELECT c.id, c.name, MIN(h.content) as snippet
                FROM project_history h
                JOIN project_chats c ON h.chat_id = c.id AND h.project = c.project
                WHERE h.project = ? AND h.content LIKE ? AND h.deleted_at = ''
                GROUP BY c.id
                ORDER BY MAX(h.timestamp) DESC
                LIMIT 20
            """
            rows = conn.execute(sql, (name, f"%{query}%")).fetchall()
            return [dict(r) for r in rows]

    def get_chat_agent_state(self, name: str, chat_id: str) -> dict:
        """Return the persisted MemGPT working state for a chat ({} when absent)."""
        with _conn(self.db_path) as conn:
            row = conn.execute(
                "SELECT agent_state FROM project_chats WHERE project = ? AND id = ?",
                (name, chat_id),
            ).fetchone()
        if not row:
            return {}
        try:
            state = json.loads(row["agent_state"] or "{}")
        except Exception:
            return {}
        return state if isinstance(state, dict) else {}

    def save_chat_agent_state(self, name: str, chat_id: str, state: dict) -> None:
        """Persist the MemGPT working state for a chat."""
        try:
            payload = json.dumps(state or {}, ensure_ascii=False)
        except Exception:
            return
        with _conn(self.db_path) as conn:
            conn.execute(
                "UPDATE project_chats SET agent_state = ? WHERE project = ? AND id = ?",
                (payload, name, chat_id),
            )

    def get_chat_context_usage(self, name: str, chat_id: str) -> dict:
        """Return the last measured context occupancy for a chat ({} when absent).

        Only a record carrying a positive ``prompt_tokens`` is a measurement; an
        empty or zeroed row means "never measured", and the caller must keep
        estimating rather than report an empty window.
        """
        with _conn(self.db_path) as conn:
            row = conn.execute(
                "SELECT context_usage FROM project_chats WHERE project = ? AND id = ?",
                (name, chat_id),
            ).fetchone()
        if not row:
            return {}
        try:
            usage = json.loads(row["context_usage"] or "{}")
        except Exception:
            return {}
        if not isinstance(usage, dict):
            return {}
        try:
            prompt = int(usage.get("prompt_tokens") or 0)
        except (TypeError, ValueError):
            return {}
        return usage if prompt > 0 else {}

    def save_chat_context_usage(self, name: str, chat_id: str, usage: dict | None) -> None:
        """Persist the measured context occupancy for a chat.

        ``None`` (or a record with no ``prompt_tokens``) clears the stored value:
        the caller has nothing measured to report and must not leave a previous
        turn's number describing the current one.
        """
        payload = "{}"
        if usage:
            try:
                if int(usage.get("prompt_tokens") or 0) > 0:
                    payload = json.dumps(usage, ensure_ascii=False)
            except (TypeError, ValueError):
                payload = "{}"
        with _conn(self.db_path) as conn:
            conn.execute(
                "UPDATE project_chats SET context_usage = ? WHERE project = ? AND id = ?",
                (payload, name, chat_id),
            )

    def update_chat_core_memory(self, name: str, chat_id: str, core_memory: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("UPDATE project_chats SET core_memory = ? WHERE project = ? AND id = ?", (core_memory, name, chat_id))

    def create_chat(self, name: str, chat_id: str, chat_name: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with _conn(self.db_path) as conn:
            conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (chat_id, name, chat_name, now, ""))

    def delete_chat(self, name: str, chat_id: str) -> None:
        # The main chat is the fallback every restore lands on; deleting it
        # would leave the project pointing at a chat that no longer exists.
        if chat_id == main_chat_id(name):
            raise ValueError(f"Cannot delete the main chat of project '{name}'")
        with _conn(self.db_path) as conn:
            # Projects whose main chat an older build already deleted are
            # protected by count instead: a project with no chat at all has
            # nowhere to restore to.
            remaining = conn.execute(
                "SELECT COUNT(*) FROM project_chats WHERE project = ? AND id != ?",
                (name, chat_id),
            ).fetchone()[0]
            if not remaining:
                raise ValueError(f"Cannot delete the last chat of project '{name}'")
        with _conn(self.db_path) as conn:
            conn.execute("DELETE FROM project_chats WHERE project = ? AND id = ?", (name, chat_id))
            conn.execute("DELETE FROM project_history WHERE project = ? AND chat_id = ?", (name, chat_id))
            conn.execute("DELETE FROM project_activity WHERE project = ? AND chat_id = ?", (name, chat_id))

    def rename_chat(self, name: str, chat_id: str, new_name: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("UPDATE project_chats SET name = ? WHERE project = ? AND id = ?", (new_name, name, chat_id))

    def _resolve_chat_message_id(
        self,
        conn,
        name: str,
        source_chat_id: str,
        message_id: int | None = None,
        client_message_id: str = "",
    ) -> int | None:
        if message_id is not None:
            row = conn.execute(
                "SELECT id FROM project_history WHERE project = ? AND chat_id = ? AND id = ?",
                (name, source_chat_id, int(message_id)),
            ).fetchone()
            if row is None:
                raise ValueError("message_id is outside the source chat history")
            return int(row["id"])

        clean_client_message_id = str(client_message_id or "").strip()
        if clean_client_message_id:
            row = conn.execute(
                """
                SELECT id FROM project_history
                WHERE project = ? AND chat_id = ? AND client_message_id = ?
                """,
                (name, source_chat_id, clean_client_message_id),
            ).fetchone()
            if row is None:
                raise ValueError("client_message_id is outside the source chat history")
            return int(row["id"])

        return None

    def _resolve_branch_source_chat_id(
        self,
        conn,
        name: str,
        source_chat_id: str,
        message_id: int | None = None,
        client_message_id: str = "",
    ) -> str:
        row = conn.execute(
            "SELECT id FROM project_chats WHERE project = ? AND id = ?",
            (name, source_chat_id),
        ).fetchone()
        if row is not None:
            return source_chat_id

        if message_id is not None:
            row = conn.execute(
                "SELECT chat_id FROM project_history WHERE project = ? AND id = ?",
                (name, int(message_id)),
            ).fetchone()
            if row is not None:
                return row["chat_id"]

        clean_client_message_id = str(client_message_id or "").strip()
        if clean_client_message_id:
            row = conn.execute(
                """
                SELECT chat_id FROM project_history
                WHERE project = ? AND client_message_id = ?
                """,
                (name, clean_client_message_id),
            ).fetchone()
            if row is not None:
                return row["chat_id"]

        rows = conn.execute(
            "SELECT id FROM project_chats WHERE project = ? ORDER BY created_at ASC",
            (name,),
        ).fetchall()
        if rows:
            return rows[-1]["id"]
        return source_chat_id

    def branch_chat(
        self,
        name: str,
        source_chat_id: str,
        new_chat_id: str,
        new_chat_name: str,
        message_index: int,
        message_id: int | None = None,
        client_message_id: str = "",
    ) -> None:
        with _conn(self.db_path) as conn:
            now = datetime.now(timezone.utc).isoformat()
            source_chat_id = self._resolve_branch_source_chat_id(
                conn,
                name,
                source_chat_id,
                message_id=message_id,
                client_message_id=client_message_id,
            )
            
            # 1. Get core memory from the original chat.
            row = conn.execute("SELECT core_memory FROM project_chats WHERE project = ? AND id = ?", (name, source_chat_id)).fetchone()
            core_memory = row["core_memory"] if row else ""
            
            # 2. Create the new chat.
            conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", 
                         (new_chat_id, name, new_chat_name, now, core_memory))
            
            # 3. Copy history through the selected persisted message.
            # Prefer stable message ids because UI indexes may omit stored system
            # audit entries such as [MODE] messages.
            target_message_id = self._resolve_chat_message_id(
                conn,
                name,
                source_chat_id,
                message_id=message_id,
                client_message_id=client_message_id,
            )
            if target_message_id is not None:
                history = conn.execute(
                    """
                    SELECT role, content, timestamp, attachments
                    FROM project_history
                    WHERE project = ? AND chat_id = ? AND id <= ? AND deleted_at = ''
                    ORDER BY id
                    """,
                    (name, source_chat_id, target_message_id),
                ).fetchall()
            else:
                if message_index < -1:
                    raise ValueError("message_index must be >= -1")
                history = conn.execute(
                    "SELECT role, content, timestamp, attachments FROM project_history"
                    " WHERE project = ? AND chat_id = ? AND deleted_at = '' ORDER BY id LIMIT ?",
                    (name, source_chat_id, message_index + 1),
                ).fetchall()
            
            for hist_row in history:
                conn.execute(
                    "INSERT INTO project_history (project, chat_id, timestamp, role, content, attachments) VALUES (?,?,?,?,?,?)",
                    (
                        name,
                        new_chat_id,
                        hist_row["timestamp"],
                        hist_row["role"],
                        hist_row["content"],
                        hist_row["attachments"] or "[]",
                    )
                )

            last_timestamp = history[-1]["timestamp"] if history else None
            if last_timestamp:
                activity = conn.execute(
                    """
                    SELECT timestamp, event, agent, content, payload
                    FROM project_activity
                    WHERE project = ? AND chat_id = ? AND timestamp <= ? AND deleted_at = ''
                    ORDER BY id
                    """,
                    (name, source_chat_id, last_timestamp),
                ).fetchall()
                for activity_row in activity:
                    conn.execute(
                        """
                        INSERT INTO project_activity
                        (project, chat_id, timestamp, event, agent, content, payload)
                        VALUES (?,?,?,?,?,?,?)
                        """,
                        (
                            name,
                            new_chat_id,
                            activity_row["timestamp"],
                            activity_row["event"],
                            activity_row["agent"],
                            activity_row["content"],
                            activity_row["payload"] or "{}",
                        ),
                    )

    def branch_chat_before_message(
        self,
        name: str,
        source_chat_id: str,
        new_chat_id: str,
        new_chat_name: str,
        *,
        message_id: int | None = None,
        client_message_id: str = "",
    ) -> list[dict]:
        """Copy every message stored *before* the anchor into a new chat.

        Used when editing a message that is not the last one: the original chat is
        left untouched and the edit continues on a branch. The anchor is a stable
        id for the same reason as ``supersede_chat_history_from_message``.
        """
        with _conn(self.db_path) as conn:
            now = datetime.now(timezone.utc).isoformat()
            anchor_id = self._resolve_chat_message_id(
                conn,
                name,
                source_chat_id,
                message_id=message_id,
                client_message_id=client_message_id,
            )
            if anchor_id is None:
                raise ValueError(
                    "message_id or client_message_id is required to branch a chat"
                )
            row = conn.execute("SELECT core_memory FROM project_chats WHERE project = ? AND id = ?", (name, source_chat_id)).fetchone()
            core_memory = row["core_memory"] if row else ""
            conn.execute(
                "INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (new_chat_id, name, new_chat_name, now, core_memory),
            )
            history = conn.execute(
                "SELECT role, content, timestamp, attachments FROM project_history"
                " WHERE project = ? AND chat_id = ? AND id < ? AND deleted_at = '' ORDER BY id",
                (name, source_chat_id, anchor_id),
            ).fetchall()
            copied = []
            for hist_row in history:
                cursor = conn.execute(
                    "INSERT INTO project_history (project, chat_id, timestamp, role, content, attachments) VALUES (?,?,?,?,?,?)",
                    (
                        name,
                        new_chat_id,
                        hist_row["timestamp"],
                        hist_row["role"],
                        hist_row["content"],
                        hist_row["attachments"] or "[]",
                    ),
                )
                copied.append({
                    "id": cursor.lastrowid,
                    "role": hist_row["role"],
                    "content": hist_row["content"],
                    "timestamp": hist_row["timestamp"],
                    "_attachments": json.loads(hist_row["attachments"] or "[]"),
                })
            last_timestamp = history[-1]["timestamp"] if history else None
            if last_timestamp:
                activity = conn.execute(
                    """
                    SELECT timestamp, event, agent, content, payload
                    FROM project_activity
                    WHERE project = ? AND chat_id = ? AND timestamp <= ? AND deleted_at = ''
                    ORDER BY id
                    """,
                    (name, source_chat_id, last_timestamp),
                ).fetchall()
                for activity_row in activity:
                    conn.execute(
                        """
                        INSERT INTO project_activity
                        (project, chat_id, timestamp, event, agent, content, payload)
                        VALUES (?,?,?,?,?,?,?)
                        """,
                        (
                            name,
                            new_chat_id,
                            activity_row["timestamp"],
                            activity_row["event"],
                            activity_row["agent"],
                            activity_row["content"],
                            activity_row["payload"] or "{}",
                        ),
                    )
            return copied

# Backward-compat alias
SessionStore = ProjectStore

def create_contextual_skills_defaults(project_path: str) -> None:
    if not project_path:
        return
    contextual_dir = os.path.join(project_path, ".opalatex", "contextual")
    os.makedirs(contextual_dir, exist_ok=True)
    
    import shutil
    template_dir = os.path.join(os.path.dirname(__file__), "templates", "contextual")
    
    if os.path.isdir(template_dir):
        for fname in ["contextual_skill_.skill", "contextual_skill_tex.skill", "contextual_skill_md.skill"]:
            src = os.path.join(template_dir, fname)
            dst = os.path.join(contextual_dir, fname)
            if os.path.exists(src) and not os.path.exists(dst):
                try:
                    shutil.copy2(src, dst)
                except Exception as e:
                    import sys
                    print(f"Warning: Failed to copy {fname} template: {e}", file=sys.stderr)
