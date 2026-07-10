"""Project management: create, load, save, and list OpalaTex projects using SQLite."""

import sqlite3
import json
import os
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

from .config import DEFAULT_DB_PATH
from .api_keys import get_env_var_for_model


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
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_compile_on_save(partial: bool, full: bool) -> tuple[bool, bool]:
    """Keep compile-on-save mode mutually exclusive; both false means disabled."""
    if full:
        return False, True
    if partial:
        return True, False
    return False, False


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
                attachments TEXT NOT NULL DEFAULT '[]',
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

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'main'")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE project_history ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        except sqlite3.OperationalError:
            pass


@dataclass
class ProjectData:
    name: str
    use_shared_memory: bool = False
    chats: list = field(default_factory=list)
    current_chat_id: str = "main"
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
    model_params: dict = field(default_factory=lambda: {"think": False, "stream": False})
    worker_model_params: dict = field(default_factory=lambda: {"think": False, "stream": False})
    api_key: str = ""
    api_base: str = ""
    worker_api_key: str = ""
    worker_api_base: str = ""
    main_file: str = ""
    git_root_path: str = ""
    compile_on_save_partial: bool = True
    compile_on_save_full: bool = False
    history: list = field(default_factory=list)   # [{role, content}]

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
        _init_schema(db_path)

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
                d["model_params"].setdefault("stream", False)
                d["worker_model_params"].setdefault("think", False)
                d["worker_model_params"].setdefault("stream", False)
                
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

    def create(self, name: str, mode: str, model: str, project_name: str = "", project_path: str = "", skills: list = None, description: str = "", worker_model: str = "", api_key: str = None, api_base: str = None, worker_api_key: str = None, worker_api_base: str = None, model_params: dict = None, worker_model_params: dict = None, apply_modelconfig: bool = True, git_root_path: str = "") -> ProjectData:
        now = datetime.now(timezone.utc).isoformat()
        _skills = skills if skills is not None else ["opalatex"]
        if "opalatex" not in _skills:
            _skills = ["opalatex"] + _skills
        _model_params = model_params if model_params is not None else {}
        _worker_model_params = worker_model_params if worker_model_params is not None else _model_params.copy()

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
            
            # 5. Pre-install all available modelconfigs from the asset store
            try:
                from .assetstore import list_assets, install_asset
                modelconfigs = list_assets(asset_type="modelconfig")
                for mcfg in modelconfigs:
                    try:
                        install_asset(mcfg, abs_proj_path)
                    except Exception:
                        pass
            except Exception:
                pass

            # 6. Apply modelconfig for the selected model
            if apply_modelconfig:
                try:
                    from .assetstore import _model_to_path
                    import yaml
                    import re
    
                    def normalize_for_match(n: str) -> str:
                        return re.sub(r'[-:_\s]+', '_', n).lower()
    
                    provider_dir, filename = _model_to_path(model)
                    provider_dir_path = os.path.join(abs_proj_path, '.opalatex', 'modelsconfig', provider_dir)
                    config_path = os.path.join(provider_dir_path, filename)
                    
                    if not os.path.isfile(config_path):
                        target_norm = normalize_for_match(filename[:-5])
                        best_match = None
                        best_len = 0
                        if os.path.isdir(provider_dir_path):
                            for f in os.listdir(provider_dir_path):
                                if not f.endswith('.yaml'): continue
                                cand_norm = normalize_for_match(f[:-5])
                                if target_norm.startswith(cand_norm):
                                    if len(cand_norm) > best_len:
                                        best_len = len(cand_norm)
                                        best_match = f
                        if best_match:
                            config_path = os.path.join(provider_dir_path, best_match)
    
                    if os.path.isfile(config_path):
                        with open(config_path, 'r', encoding='utf-8') as f:
                            config = yaml.safe_load(f) or {}
                        
                        if 'provider' in config:
                            new_provider = config.pop('provider')
                            if '/' in model:
                                _, m_name = model.split('/', 1)
                            else:
                                m_name = model
                            model = f"{new_provider}/{m_name}"
                        
                        if 'api_base' in config:
                            config_api_base = config.pop('api_base')
                            if not api_base: 
                                api_base = config_api_base
                                api_key_var, api_base_var = _api_credential_names(model)
                                upsert_env(api_base_var or "OPENAI_API_BASE", api_base)
                                
                        if 'api_key' in config:
                            config_api_key = config.pop('api_key')
                            if not api_key: 
                                api_key = config_api_key
                                api_key_var, api_base_var = _api_credential_names(model)
                                upsert_env(api_key_var or "OPENAI_API_KEY", api_key)
                                
                        if 'worker_model' in config:
                            alt_model = config.pop('worker_model')
                            if not worker_model:
                                worker_model = alt_model
                                
                        for k, v in config.items():
                            if v is not None:
                                # Only set if it's missing or if the current value is empty/None
                                if k not in _model_params or _model_params[k] in (None, ""):
                                    _model_params[k] = v
                                if k not in _worker_model_params or _worker_model_params[k] in (None, ""):
                                    _worker_model_params[k] = v
                                
                except Exception:
                    pass

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
            chat_id = f"main_{name}"
            conn.execute(
                "INSERT OR IGNORE INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (chat_id, name, "Main Chat", now, "")
            )
        return ProjectData(name=name, use_shared_memory=False, chats=[{"id": chat_id, "name": "Main Chat"}], current_chat_id=chat_id, mode=mode, model=model, worker_model=worker_model, project_name=project_name, project_path=abs_proj_path, skills=_skills, description=description, core_memory="", model_params=_model_params, worker_model_params=_worker_model_params, api_key=api_key or "", api_base=api_base or "", worker_api_key=worker_api_key or "", worker_api_base=worker_api_base or "", main_file="", git_root_path=os.path.abspath(git_root_path) if git_root_path else "", compile_on_save_partial=True, compile_on_save_full=False)

    def overwrite(self, name: str, mode: str, model: str, project_name: str = "", project_path: str = "", skills: list = None, description: str = "", worker_model: str = "", api_key: str = None, api_base: str = None, worker_api_key: str = None, worker_api_base: str = None, model_params: dict = None, worker_model_params: dict = None, use_shared_memory: bool = False) -> ProjectData:
        self.delete(name)
        new_proj = self.create(name, mode, model, project_name, project_path, skills, description, worker_model, api_key=api_key, api_base=api_base, worker_api_key=worker_api_key, worker_api_base=worker_api_base, model_params=model_params, worker_model_params=worker_model_params, apply_modelconfig=False)
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

    def load(self, name: str, chat_id: str = "main") -> Optional[ProjectData]:
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
            
            if not any(c["id"] == chat_id for c in chats):
                if chats:
                    chat_id = chats[-1]["id"]
                else:
                    chat_id = f"main_{name}"
                    try:
                        conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (chat_id, name, "Main Chat", datetime.now(timezone.utc).isoformat(), ""))
                    except sqlite3.IntegrityError:
                        # Fallback if somehow it already exists but wasn't in chats?
                        chat_id = str(uuid.uuid4())
                        conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (chat_id, name, "Main Chat", datetime.now(timezone.utc).isoformat(), ""))
                    chats = [{"id": chat_id, "name": "Main Chat"}]
                    
            hist_rows = conn.execute(
                "SELECT id, role, content, timestamp, attachments FROM project_history WHERE project = ? AND chat_id = ? ORDER BY id",
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
                model=row["model"],
                worker_model=row["worker_model"] if "worker_model" in row.keys() else (row["alternative_model"] if "alternative_model" in row.keys() else ""),
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
                    "think": False, "stream": False,
                    **(json.loads(row["model_params"]) if "model_params" in row.keys() else {}),
                },
                worker_model_params={
                    "think": False, "stream": False,
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

    def append_message(self, project: ProjectData, role: str, content: str, attachments: list | None = None) -> int:
        now = datetime.now(timezone.utc).isoformat()
        message_id = None
        clean_attachments = attachments or []
        with _conn(self.db_path) as conn:
            cursor = conn.execute(
                "INSERT INTO project_history (project, chat_id, timestamp, role, content, attachments) VALUES (?,?,?,?,?,?)",
                (
                    project.name,
                    project.current_chat_id,
                    now,
                    role,
                    content,
                    json.dumps(clean_attachments, ensure_ascii=False),
                ),
            )
            message_id = cursor.lastrowid
            
        message = {"id": message_id, "role": role, "content": content, "timestamp": now}
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


    def clear_project_history(self, name: str, chat_id: str = None) -> None:
        with _conn(self.db_path) as conn:
            if chat_id:
                conn.execute("DELETE FROM project_history WHERE project = ? AND chat_id = ?", (name, chat_id))
            else:
                conn.execute("DELETE FROM project_history WHERE project = ?", (name,))

    def truncate_chat_history_from_index(self, name: str, chat_id: str, from_index: int) -> list[int]:
        if from_index < 0:
            raise ValueError("from_index must be >= 0")
        with _conn(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id FROM project_history WHERE project = ? AND chat_id = ? ORDER BY id",
                (name, chat_id),
            ).fetchall()
            if from_index >= len(rows):
                raise ValueError("from_index is outside the chat history")
            deleted_ids = [int(r["id"]) for r in rows[from_index:]]
            placeholders = ",".join("?" for _ in deleted_ids)
            conn.execute(
                f"DELETE FROM project_history WHERE project = ? AND chat_id = ? AND id IN ({placeholders})",
                (name, chat_id, *deleted_ids),
            )
        try:
            from .archival import get_collection
            collection = get_collection(name)
            collection.delete(ids=[str(i) for i in deleted_ids])
        except Exception:
            pass

        return deleted_ids

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
                WHERE h.project = ? AND h.content LIKE ?
                GROUP BY c.id
                ORDER BY MAX(h.timestamp) DESC
                LIMIT 20
            """
            rows = conn.execute(sql, (name, f"%{query}%")).fetchall()
            return [dict(r) for r in rows]

    def update_chat_core_memory(self, name: str, chat_id: str, core_memory: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("UPDATE project_chats SET core_memory = ? WHERE project = ? AND id = ?", (core_memory, name, chat_id))

    def create_chat(self, name: str, chat_id: str, chat_name: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with _conn(self.db_path) as conn:
            conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", (chat_id, name, chat_name, now, ""))

    def delete_chat(self, name: str, chat_id: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("DELETE FROM project_chats WHERE project = ? AND id = ?", (name, chat_id))
            conn.execute("DELETE FROM project_history WHERE project = ? AND chat_id = ?", (name, chat_id))

    def rename_chat(self, name: str, chat_id: str, new_name: str) -> None:
        with _conn(self.db_path) as conn:
            conn.execute("UPDATE project_chats SET name = ? WHERE project = ? AND id = ?", (new_name, name, chat_id))

    def branch_chat(self, name: str, source_chat_id: str, new_chat_id: str, new_chat_name: str, message_index: int) -> None:
        with _conn(self.db_path) as conn:
            now = datetime.now(timezone.utc).isoformat()
            
            # 1. Obter core memory do chat original
            row = conn.execute("SELECT core_memory FROM project_chats WHERE project = ? AND id = ?", (name, source_chat_id)).fetchone()
            core_memory = row["core_memory"] if row else ""
            
            # 2. Criar novo chat
            conn.execute("INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)", 
                         (new_chat_id, name, new_chat_name, now, core_memory))
            
            # 3. Copiar histórico até message_index
            history = conn.execute(
                "SELECT role, content, timestamp, attachments FROM project_history WHERE project = ? AND chat_id = ? ORDER BY id LIMIT ?",
                (name, source_chat_id, message_index + 1)
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

    def branch_chat_prefix(self, name: str, source_chat_id: str, new_chat_id: str, new_chat_name: str, limit: int) -> list[dict]:
        if limit < 0:
            raise ValueError("limit must be >= 0")
        with _conn(self.db_path) as conn:
            now = datetime.now(timezone.utc).isoformat()
            row = conn.execute("SELECT core_memory FROM project_chats WHERE project = ? AND id = ?", (name, source_chat_id)).fetchone()
            core_memory = row["core_memory"] if row else ""
            conn.execute(
                "INSERT INTO project_chats (id, project, name, created_at, core_memory) VALUES (?,?,?,?,?)",
                (new_chat_id, name, new_chat_name, now, core_memory),
            )
            history = conn.execute(
                "SELECT role, content, timestamp, attachments FROM project_history WHERE project = ? AND chat_id = ? ORDER BY id LIMIT ?",
                (name, source_chat_id, limit),
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
