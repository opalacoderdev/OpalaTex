"""REPL command registry and handlers for OpalaTex CLI."""

from .project import ProjectStore, ProjectData
from . import terminal as T
from .i18n import _
from rich.markup import escape as _escape


# ─── REPL state container ─────────────────────────────────────────────────────

class REPLState:
    def __init__(self, project: ProjectData, store: ProjectStore):
        self.project = project
        self.store = store
        # Skills-oriented architecture: the fixed MemGPT chat-orchestrator, built
        # once per session (classic memory accumulates across turns) and rebuilt on
        # /load and /clear. It both converses and delegates to skills via run_skill.
        from .memgpt_runtime import build_chat_orchestrator
        self.memgpt = build_chat_orchestrator(project, store)

    @property
    def display_name(self) -> str:
        return self.project.project_name or self.project.name


# ─── Command registry ─────────────────────────────────────────────────────────

class CommandRegistry:
    def __init__(self):
        self._cmds: dict[str, tuple] = {}

    def register(self, *names: str, usage: str = "", description: str = ""):
        def decorator(fn):
            for name in names:
                self._cmds[name] = (fn, usage, description)
            return fn
        return decorator

    def __contains__(self, cmd: str) -> bool:
        return cmd in self._cmds

    def help_lines(self) -> list[tuple[str, str]]:
        seen, result = set(), []
        for name, (fn, usage, desc) in self._cmds.items():
            if fn not in seen:
                seen.add(fn)
                result.append((f"{name} {usage}".strip(), desc))
        return result

    async def dispatch(self, state: REPLState, cmd: str, args: list[str]) -> str | None:
        fn, _, _ = self._cmds[cmd]
        return await fn(state, args)


_registry = CommandRegistry()


# ─── Command handlers ─────────────────────────────────────────────────────────

@_registry.register("/help", "/h", description="Show this help message")
async def cmd_help(_state: REPLState, _args: list[str]) -> None:
    T.console.print(f"\n[cyan]{_('available_commands')}[/cyan]")
    for display, desc in _registry.help_lines():
        T.console.print(f"  [green]{display:<28}[/green] {desc}")
    T.console.print()


@_registry.register("/clear", description="Clear project memory and ALL chats histories")
async def cmd_clear(state: REPLState, _args: list[str]) -> None:
    if await T.aconfirm("Are you sure you want to clear this project's global memory and ALL chats?"):
        state.project = state.store.overwrite(
            state.project.name, state.project.mode, state.project.model,
            state.project.project_name, state.project.project_path,
            state.project.skills, state.project.description,
            worker_model=state.project.worker_model,
            api_key=state.project.api_key,
            api_base=state.project.api_base,
            worker_api_key=state.project.worker_api_key,
            worker_api_base=state.project.worker_api_base,
            model_params=state.project.model_params,
            use_shared_memory=state.project.use_shared_memory,
        )
        from .memgpt_runtime import build_chat_orchestrator
        state.memgpt = build_chat_orchestrator(state.project, state.store)
        from .archival import clear_archival
        clear_archival(state.project.name)
        # Every chat is gone, so no stored measurement describes anything.
        from .token_usage import reset_context_usage
        reset_context_usage()
        T.success("Project global memory and all chats cleared.")
    else:
        T.warning("Ação cancelada.")

@_registry.register("/clear_chat", description="Clear only the current chat's history and its isolated memory (if any)")
async def cmd_clear_chat(state: REPLState, _args: list[str]) -> None:
    chat_id = getattr(state.project, "current_chat_id", "main")
    if await T.aconfirm(f"Are you sure you want to clear chat '{chat_id}' history?"):
        from .chat_ops import clear_chat
        state.project = clear_chat(state.project, state.store, chat_id)
        from .memgpt_runtime import build_chat_orchestrator
        state.memgpt = build_chat_orchestrator(state.project, state.store)
        T.success(f"Chat '{chat_id}' cleared.")
    else:
        T.warning("Ação cancelada.")



@_registry.register("/rename", usage="<new_name>", description="Rename the current project")
async def cmd_rename(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /rename <new_name>")
        return "continue"
    new_name = args[0].strip('"\'')
    if state.store.rename(state.project.name, new_name):
        state.project.name = new_name
        state.store.save(state.project)
        T.success(f"Project renamed to '{new_name}'.")
    else:
        T.error(f"A project named '{new_name}' already exists.")


@_registry.register("/list", description="List all projects")
async def cmd_list(state: REPLState, _args: list[str]) -> None:
    projects = state.store.list_projects()
    if not projects:
        T.info("No projects found.")
    else:
        T.console.print(f"\n[dim]Existing projects:[/dim]")
        for p in projects:
            pname = p["project_name"] or p["name"]
            T.console.print(
                f"  [cyan]{_escape(p['name'])}[/cyan]  "
                f"[bold]{_escape(pname)}[/bold]  "
                f"[dim]{_escape(p['project_path'])}  {p['updated_at'][:10]}  mode={p['mode']}[/dim]"
            )
        T.console.print()


@_registry.register("/load", usage="<name>", description="Load another project")
async def cmd_load(state: REPLState, args: list[str]) -> str | None:
    from .tools import set_project_context
    if not args:
        T.error("Usage: /load <name>")
        return "continue"
    name = args[0].strip('"\'')
    if not state.store.exists(name):
        T.error(f"Project '{name}' not found.")
        return "continue"
    loaded = state.store.load(name)
    if loaded:
        state.project = loaded
        set_project_context(state.project, state.store)
        # Rebuild the MemGPT for the newly loaded project (re-scopes file tools and
        # reseeds memory from the loaded project's history).
        from .memgpt_runtime import build_chat_orchestrator
        state.memgpt = build_chat_orchestrator(state.project, state.store)
        T.success(f"Project '{name}' loaded.")
        T.console.print(f"  [dim]Skills: {', '.join(state.project.skills)}[/dim]")
        if state.project.request and state.project.plan_text and not state.project.results:
            T.warning(_("pending_demand", request=state.project.request[:50]))
    else:
        T.error(f"Project '{name}' not found.")


@_registry.register("/delete", usage="<name>", description="Delete a project")
async def cmd_delete(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /delete <name>")
        return "continue"
    name = args[0].strip('"\'')
    if not state.store.exists(name):
        T.error(f"Project '{name}' not found.")
        return "continue"
    
    project_to_delete = state.store.load(name)
    state.store.delete(name)

    import os
    import shutil
    if project_to_delete and project_to_delete.project_path and os.path.exists(project_to_delete.project_path):
        if await T.aconfirm(_("delete_dir_confirm", path=project_to_delete.project_path), default=False):
            try:
                shutil.rmtree(project_to_delete.project_path)
                T.success(_("dir_deleted", path=project_to_delete.project_path))
            except Exception as e:
                T.error(_("dir_delete_failed", err=str(e)))
        else:
            opalatex_dir = os.path.join(project_to_delete.project_path, ".opalatex")
            if os.path.exists(opalatex_dir):
                try:
                    shutil.rmtree(opalatex_dir)
                    T.success(_("vcs_deleted"))
                except Exception as e:
                    T.error(_("vcs_delete_failed", err=str(e)))

    T.success(f"Project '{name}' deleted.")
    if state.project.name == name:
        T.info("Current project was deleted. Please restart OpalaTex.")
        return "break"


def _rebuild_memgpt(state: REPLState) -> None:
    """Rebuild the MemGPT so a skills.yaml change takes effect immediately."""
    from .memgpt_runtime import build_chat_orchestrator
    state.memgpt = build_chat_orchestrator(state.project, state.store)


@_registry.register("/lsskills", description="List active skills for this project")
async def cmd_lsskills(state: REPLState, _args: list[str]) -> None:
    from .skills import active_skills
    T.console.print(f"\n[dim]Active skills for this project:[/dim]")
    for s in active_skills(state.project.project_path):
        T.console.print(f"  [cyan]{s['name']}[/cyan]  [dim]{s['description']}[/dim]")
    T.console.print()


@_registry.register("/skills", description="List all available skills (active marked with *)")
async def cmd_skills(state: REPLState, _args: list[str]) -> None:
    from .skills import discover_skills, active_skills
    discovered = discover_skills(state.project.project_path)
    active_names = {s["name"] for s in active_skills(state.project.project_path)}
    if not discovered:
        T.info("No skills found.")
        return
    T.console.print(f"\n[dim]Available skills:[/dim]")
    for s in discovered:
        mark = "[green]*[/green] " if s["name"] in active_names else "  "
        T.console.print(f"  {mark}[cyan]{s['name']}[/cyan]  [dim]{s['description']}[/dim]")
    T.console.print(f"\n[dim]([green]*[/green] = active in this project)[/dim]\n")


@_registry.register("/addskill", usage="<name>", description="Add a skill to this project")
async def cmd_addskill(state: REPLState, args: list[str]) -> str | None:
    from .skills import add_skill_to_project
    if not args:
        T.error("Usage: /addskill <skill_name>")
        return "continue"
    skill_name = args[0].strip().lower()
    changed, msg = add_skill_to_project(state.project.project_path, skill_name)
    if changed:
        _rebuild_memgpt(state)
        T.success(msg)
    else:
        T.info(msg)


@_registry.register("/rmskill", usage="<name>", description="Remove a skill from this project")
async def cmd_rmskill(state: REPLState, args: list[str]) -> str | None:
    from .skills import remove_skill_from_project
    if not args:
        T.error("Usage: /rmskill <skill_name>")
        return "continue"
    skill_name = args[0].strip().lower()
    changed, msg = remove_skill_from_project(state.project.project_path, skill_name)
    if changed:
        _rebuild_memgpt(state)
        T.success(msg)
    else:
        T.info(msg)


# ─── Model commands ───────────────────────────────────────────────────────────

@_registry.register("/models", description="Show the models in use for this project")
async def cmd_models(state: REPLState, _args: list[str]) -> None:
    from .config import DEFAULT_MODEL, WORKER_MODEL
    main_model = state.project.model or DEFAULT_MODEL
    alt_model = state.project.worker_model or WORKER_MODEL
    alt_origin = "project" if state.project.worker_model else "global (agents.yaml)"
    T.console.print(f"\n[dim]Models for project '{state.display_name}':[/dim]")
    T.console.print(f"  [cyan]main[/cyan]        {main_model}")
    T.console.print(f"  [cyan]worker[/cyan]      {alt_model}  [dim]({alt_origin})[/dim]")
    params = getattr(state.project, "model_params", {})
    if params:
        T.console.print(f"  [cyan]parameters[/cyan]")
        for k, v in params.items():
            T.console.print(f"    {k}: {v}")
    T.console.print(f"\n[dim]Change with /set-main-model <id>, /set-worker-model <id>, or /set-model-param <name> <value>.[/dim]\n")


@_registry.register("/set-main-model", usage="<model_id>",
                    description="Set the main model for this project")
async def cmd_set_main_model(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /set-main-model <model_id>  (e.g. ollama/gemma4:latest)")
        return "continue"
    model_id = args[0].strip()
    state.project.model = model_id
    state.store.save(state.project)
    _rebuild_memgpt(state)
    T.success(f"Main model set to '{model_id}' for this project.")


@_registry.register("/set-worker-model", usage="<model_id>",
                    description="Set the worker model for this project")
async def cmd_set_worker_model(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /set-worker-model <model_id>  (e.g. gemini/gemini-2.0-flash)")
        return "continue"
    model_id = args[0].strip()
    state.project.worker_model = model_id
    state.store.save(state.project)
    _rebuild_memgpt(state)
    T.success(f"Worker model set to '{model_id}' for this project.")


def _parse_model_param_value(val_str: str):
    """Infer the Python type of a model parameter value from its string representation.

    Priority: bool literals → int → float → string.
    Returns the typed value or raises ValueError with a descriptive message.
    """
    low = val_str.lower()
    if low in {"true", "on", "yes"}:
        return True
    if low in {"false", "off", "no"}:
        return False
    if low == "null" or low == "none":
        return None
    try:
        return int(val_str)
    except ValueError:
        pass
    try:
        return float(val_str)
    except ValueError:
        pass
    # Validate: reject values that look like typos (contain spaces, control chars)
    if not val_str.isprintable():
        raise ValueError("Value contains non-printable characters")
    return val_str


@_registry.register("/set-model-param", usage="<param_name> <value>",
                    description="Set any LiteLLM/model parameter (e.g. temperature, reasoning_effort, seed, stop, num_ctx, think, ...)")
async def cmd_set_model_param(state: REPLState, args: list[str]) -> str | None:
    if len(args) < 2:
        T.error("Usage: /set-model-param <param_name> <value>\n"
                "Accepts any parameter supported by LiteLLM/Ollama.\n"
                "Values are auto-typed: integers, floats, booleans (true/false/on/off/yes/no), or strings.")
        return "continue"

    param = args[0].strip()
    val_str = " ".join(args[1:]).strip()

    if not param or not param.replace("_", "").replace("-", "").isalnum():
        T.error(f"Invalid parameter name '{param}'. Use only letters, digits, underscores and hyphens.")
        return "continue"

    try:
        val = _parse_model_param_value(val_str)
    except ValueError as e:
        T.error(f"Invalid value for '{param}': {e}")
        return "continue"

    if not hasattr(state.project, "model_params") or state.project.model_params is None:
        state.project.model_params = {}

    state.project.model_params[param] = val
    try:
        state.store.save(state.project)
        _rebuild_memgpt(state)
    except Exception as e:
        # Roll back the in-memory change so the project stays consistent
        state.project.model_params.pop(param, None)
        T.error(
            f"Failed to apply parameter '{param}': {e}\n"
            "The parameter was not saved. Check the value and try again."
        )
        return "continue"
    T.success(f"Model parameter '{param}' set to {repr(val)} for this project.")


@_registry.register(
    "/load_asset",
    usage="<type> <desc|id|*>",
    description="Install an asset from the AssetStore into the active project. type=skill|template, desc=id/description or * for all.",
)
async def cmd_load_asset(state: REPLState, args: list[str]) -> str | None:
    from .assetstore import find_assets, install_asset, VALID_TYPES

    if len(args) < 2:
        T.error(
            "Usage: /load_asset <type> <desc|id|*>\n"
            f"  type: {', '.join(sorted(VALID_TYPES))}\n"
            "  desc: asset id, description, or * to install all of the type"
        )
        return "continue"

    asset_type = args[0].strip().lower()
    desc = " ".join(args[1:]).strip()

    if asset_type not in VALID_TYPES:
        T.error(f"Unknown type '{asset_type}'. Must be one of: {', '.join(sorted(VALID_TYPES))}")
        return "continue"

    matches = find_assets(asset_type, desc)
    if not matches:
        if desc == "*":
            T.warning(f"No {asset_type} assets found in the AssetStore.")
        else:
            T.warning(f"No {asset_type} asset matching '{desc}' found in the AssetStore.")
        return "continue"

    project_path = state.project.project_path
    installed = []
    errors = []
    for meta in matches:
        try:
            msg = install_asset(meta, project_path)
            installed.append(msg)
        except Exception as e:
            errors.append(f"{meta.get('id', '?')}: {e}")

    for msg in installed:
        T.success(f"Installed: {msg}")
    for err in errors:
        T.error(f"Failed: {err}")

    if installed and asset_type == "skill":
        T.console.print(
            "[dim]Tip: use /addskill <name> to activate the skill in this project.[/dim]"
        )

    return "continue"


@_registry.register("/list_assets",
    usage="[type]",
    description="List available assets in the AssetStore. type=skill|template (optional).")
async def cmd_list_assets(_state: REPLState, args: list[str]) -> str | None:
    from .assetstore import list_assets, VALID_TYPES

    asset_type = args[0].strip().lower() if args else None
    if asset_type and asset_type not in VALID_TYPES:
        T.error(f"Unknown type '{asset_type}'. Must be one of: {', '.join(sorted(VALID_TYPES))}")
        return "continue"

    assets = list_assets(asset_type)
    if not assets:
        T.warning("No assets found in the AssetStore.")
        return "continue"

    T.console.print(f"\n[cyan]{_('available_commands')}[/cyan]".replace("commands", "assets"))
    for a in sorted(assets, key=lambda x: (x.get("type", ""), x.get("id", ""))):
        label = f"{a.get('id', '?')} [{a.get('type', '')}]"
        T.console.print(f"  [green]{label:<40}[/green] {a.get('desc', '')}")
    T.console.print()
    return "continue"


@_registry.register("/undo", description=_("undo_desc"))
async def cmd_undo(state: REPLState, _args: list[str]) -> str | None:
    from .vcs import get_vcs_strategy
    from .config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    try:
        vcs.setup()
    except Exception as e:
        T.error(f"Failed to setup VCS: {e}")
    success, msg = vcs.undo_last()
    if success:
        T.success(_("undo_success"))
    else:
        T.error(_("undo_fail") + f" ({msg})")
    return "continue"


@_registry.register("/commit", usage="<message>", description=_("commit_desc"))
async def cmd_commit(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /commit <message>")
        return "continue"
    message = " ".join(args).strip('"\'')
    from .vcs import get_vcs_strategy
    from .config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    try:
        vcs.setup()
    except Exception as e:
        T.error(f"Failed to setup VCS: {e}")
    success, msg = vcs.manual_commit(message)
    if success:
        T.success(_("commit_success"))
    else:
        T.error(_("commit_fail", err=msg))
    return "continue"


@_registry.register("/checkpoints", description="List all checkpoints (commits) in the shadow git")
async def cmd_checkpoints(state: REPLState, _args: list[str]) -> str | None:
    from .vcs import get_vcs_strategy
    from .config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    try:
        vcs.setup()
    except Exception as e:
        T.error(f"Failed to setup VCS: {e}")
    success, msg = vcs.list_checkpoints()
    if success:
        T.info("Checkpoints:")
        T.console.print(msg)
    else:
        T.error(f"Failed to list checkpoints: {msg}")
    return "continue"


@_registry.register("/restoreckp", usage="<checkpoint_id>", description="Restore the project to a specific checkpoint")
async def cmd_restoreckp(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /restoreckp <checkpoint_id>")
        return "continue"
    checkpoint_id = args[0].strip()
    from .vcs import get_vcs_strategy
    from .config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    try:
        vcs.setup()
    except Exception as e:
        T.error(f"Failed to setup VCS: {e}")
        
    if await T.aconfirm(f"Are you sure you want to restore to checkpoint '{checkpoint_id}'? This will discard all current changes.", default=False):
        success, msg = vcs.restore_checkpoint(checkpoint_id)
        if success:
            T.success(msg)
        else:
            T.error(msg)
    else:
        T.warning("Ação cancelada.")
    return "continue"


@_registry.register("/removechk", usage="<checkpoint_id>", description="Remove a specific checkpoint from history")
async def cmd_removechk(state: REPLState, args: list[str]) -> str | None:
    if not args:
        T.error("Usage: /removechk <checkpoint_id>")
        return "continue"
    checkpoint_id = args[0].strip()
    from .vcs import get_vcs_strategy
    from .config import get_git_strategy
    vcs = get_vcs_strategy(get_git_strategy(), state.project.project_path)
    try:
        vcs.setup()
    except Exception as e:
        T.error(f"Failed to setup VCS: {e}")
        
    if await T.aconfirm(f"Are you sure you want to remove checkpoint '{checkpoint_id}'?", default=False):
        success, msg = vcs.remove_checkpoint(checkpoint_id)
        if success:
            T.success(msg)
        else:
            T.error(msg)
    else:
        T.warning("Ação cancelada.")
    return "continue"


@_registry.register("/history", usage="[n]", description="Show conversation history (last n messages, default all)")
async def cmd_history(state: REPLState, args: list[str]) -> str | None:
    limit: int | None = None
    if args:
        try:
            limit = int(args[0])
            if limit <= 0:
                T.error("Usage: /history [n]  — n must be a positive integer")
                return "continue"
        except ValueError:
            T.error("Usage: /history [n]  — n must be a positive integer")
            return "continue"

    history = state.project.history
    if not history:
        T.info("No conversation history for this project.")
        return "continue"

    messages = history[-limit:] if limit else history
    total = len(history)
    showing = len(messages)

    T.console.print(
        f"\n[dim]Conversation history for '{_escape(state.display_name)}' "
        f"— showing {showing} of {total} message(s):[/dim]\n"
    )

    role_styles = {"user": "bold cyan", "assistant": "bold green"}
    role_labels = {"user": "You", "assistant": "OpalaTex"}

    for i, msg in enumerate(messages, start=total - showing + 1):
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        style = role_styles.get(role, "bold yellow")
        label = role_labels.get(role, role.capitalize())

        # Truncate very long messages for readability
        display = content if len(content) <= 500 else content[:497] + "..."
        T.console.print(f"[{style}][{i}] {label}:[/{style}] {_escape(display)}\n")

    T.console.print(f"[dim]{'─' * 40}[/dim]\n")
    return "continue"


@_registry.register("/exit", "/quit", description=_("exit_desc"))
async def cmd_exit(_state: REPLState, _args: list[str]) -> str:
    T.info(_("exiting"))
    return "break"
