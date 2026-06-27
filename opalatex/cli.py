"""OpalaTex CLI – entry point."""

import asyncio
import argparse
import os
import sys

from . import __version__
from .config import DEFAULT_MODEL, DEFAULT_MAX_RETRIES, DEFAULT_MODE, DEFAULT_DB_PATH, DEFAULT_LANG
from .project import ProjectStore, ProjectData
from . import terminal as T
from agenticblocks.blocks.llm.agent import AgentInput
from .i18n import _, set_lang
from rich.markup import escape as _escape
from .cli_commands import REPLState, _registry

def _inject_project(project: ProjectData, prompt: str) -> str:
    """Prepend project context to every prompt sent to agents."""
    return project.context_header() + prompt


# ─── Project startup menu ─────────────────────────────────────────────────────

async def startup_menu(store: ProjectStore, args) -> ProjectData:
    """Show the project selection/creation menu and return a ready ProjectData."""
    projects = store.list_projects()

    if projects:
        options = ["Create new project"] + [
            f"{p['project_name'] or p['name']}  [{p['project_path']}]"
            for p in projects
        ]
        choice = T.choose("What would you like to do?", options[:4] if len(options) > 4 else options)
        if choice == "Create new project":
            return await _create_project(store, args)
        else:
            idx = options.index(choice) - 1
            name = projects[idx]["name"]
            project = store.load(name)
            project.mode = args.mode
            project.model = args.model
            store.save(project)
            T.success(f"Project '{project.project_name or project.name}' loaded.")
            return project
    else:
        T.info("No projects found. Let's create your first one.")
        return await _create_project(store, args)


async def _create_project(store: ProjectStore, args) -> ProjectData:
    """Interactively create a new project.

    A new project starts minimal: only the mandatory chat-orchestrator skill is
    active. Other skills are opt-in — the user adds them with /addskill (which
    writes <project>/skills.yaml). No development skill is auto-loaded.
    """
    from .skills import discover_skills, MANDATORY_SKILLS

    project_name = T.ask("Project name").strip() or "default"
    cwd = os.getcwd()
    entered_path = T.ask(f"Project path [{cwd}]").strip()
    project_path = os.path.abspath(entered_path if entered_path else cwd)

    if not os.path.exists(project_path):
        os.makedirs(project_path, exist_ok=True)
        T.success(f"Directory created: {project_path}")

    description = T.ask("Brief project description").strip()

    optional = [s["name"] for s in discover_skills(project_path)
                if s["name"] not in MANDATORY_SKILLS]
    if optional:
        T.info(f"Available skills (add with /addskill): {', '.join(optional)}")

    db_key = project_name.replace(" ", "_").lower()
    if store.exists(db_key):
        db_key = db_key + "_1"

    project = store.create(
        name=db_key,
        mode=args.mode,
        model=args.model,
        project_name=project_name,
        project_path=project_path,
        skills=list(MANDATORY_SKILLS),
        description=description,
    )
    T.success(f"Project '{project_name}' created.")
    return project


# ─── REPL Loop ────────────────────────────────────────────────────────────────

async def repl_loop(project: ProjectData, store: ProjectStore, max_retries: int) -> None:
    from .tools import set_project_context
    from .skills import active_skills

    set_project_context(project, store)

    T.section(f"Active Project: {_escape(project.project_name or project.name)}")
    T.console.print(f"  [dim]Path:   {_escape(project.project_path)}[/dim]")
    _active = ", ".join(s["name"] for s in active_skills(project.project_path))
    T.console.print(f"  [dim]Skills: {_active}[/dim]")

    # REPLState builds the MemGPT chat-orchestrator (and seeds its memory from
    # project.history).
    state = REPLState(project, store)

    async def _resume_via_memgpt() -> None:
        """Route resume through the MemGPT: it will call run_skill to continue."""
        store.append_message(state.project, "user", "[RESUME] continue the previous implementation")
        with T.spinner(_("agent_thinking")):
            resp = await state.memgpt.run(AgentInput(
                prompt=_inject_project(state.project,
                    "Continue or complete the previous implementation that was interrupted.")
            ))
        if resp.response:
            T.console.print(f"\n[bold green]OpalaTex:[/bold green] {resp.response.strip()}\n")
            store.append_message(state.project, "assistant", resp.response.strip())
        store.save(state.project)

    if state.project.request and state.project.plan_text and not state.project.results:
        T.warning(_("pending_demand", request=state.project.request[:50]))
        choice = T.choose(_("resume_or_clear"), [_("resume"), _("clear")])
        if choice == _("resume"):
            await _resume_via_memgpt()
        else:
            state.project.clear_state()
            store.save(state.project)
    else:
        checkpoint_path = os.path.join(project.project_path, CHECKPOINT_SUBPATH)
        if os.path.exists(checkpoint_path):
            T.warning("[yellow]Foi detectada uma execução de agente não finalizada (checkpoint salvo).[/yellow]")
            choice = T.choose(_("resume_or_clear"), [_("resume"), _("clear")])
            if choice == _("resume"):
                await _resume_via_memgpt()
            else:
                try:
                    os.remove(checkpoint_path)
                except Exception:
                    pass

    while True:
        try:
            user_input = T.ask(f"OpalaTex ({state.display_name})")
            if not user_input:
                continue

            if user_input.startswith("/"):
                cmd, *args = user_input.split(maxsplit=1)
                if cmd not in _registry:
                    T.error(_("unknown_command", cmd=cmd))
                    continue
                result = await _registry.dispatch(state, cmd, args)
                if result == "break":
                    break
                elif result == "continue":
                    continue

            else:
                # Skills-oriented architecture: the fixed MemGPT chat-orchestrator
                # handles BOTH conversation and orchestration. It converses directly
                # and, when a request matches a skill, calls run_skill(...) which
                # spawns a sub-agent (whose dialogue is mirrored back into the MemGPT
                # memory by the interceptor). No separate intent classifier.
                store.append_message(state.project, "user", user_input)
                with T.spinner(_("agent_thinking")):
                    resp_obj = await state.memgpt.run(
                        AgentInput(prompt=_inject_project(state.project, user_input))
                    )
                response = resp_obj.response.strip() if resp_obj.response else ""
                if response:
                    T.console.print(f"\n[bold green]OpalaTex:[/bold green] {response}\n")
                    store.append_message(state.project, "assistant", response)
                store.save(state.project)

        except KeyboardInterrupt:
            T.info(_("repl_interrupted"))
            break
        except EOFError:
            T.info(_("exiting"))
            break
        except T.UserCancelled:
            T.info(_("repl_cancelled"))
            state.project.clear_state()
            store.save(state.project)
        except T.AppExit:
            T.info(_("exiting"))
            break
        except Exception as e:
            T.section(_("phase_5"))
            import traceback
            traceback.print_exc()
            T.error(_("unexpected_error", err=e))


# ─── CLI entrypoint ───────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opalatex",
        description="OpalaTex – project-centric coding agent",
    )
    parser.add_argument("--version", action="version", version=f"OpalaTex {__version__}")
    parser.add_argument("--mode", choices=["auto", "plan", "edit"], default=DEFAULT_MODE)
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"LLM model (default: {DEFAULT_MODEL})")
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--lang", choices=["en", "pt"], default=DEFAULT_LANG)
    parser.add_argument("--delete", metavar="PROJECT_NAME", help="Delete a project and exit")
    parser.add_argument("--list-projects", action="store_true", help="List all projects and exit")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--stdin", action="store_true", help="Start agent server in stdin/stdout mode")
    parser.add_argument("--gui", action="store_true", help="Start agent server with React Web GUI (Default)")
    parser.add_argument("--cli", action="store_true", help="Start in interactive CLI REPL mode")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.debug:
        from opalatex.config import setup_debug_logging
        setup_debug_logging()

    set_lang(args.lang)

    if getattr(args, "stdin", False):
        from .agent_stdin import start_stdin_server
        start_stdin_server()
        sys.exit(0)

    store = ProjectStore(db_path=args.db)

    if getattr(args, "list_projects", False):
        projects = store.list_projects()
        if not projects:
            T.info("No projects found.")
        else:
            T.section("Existing Projects")
            for p in projects:
                pname = p["project_name"] or p["name"]
                T.console.print(
                    f"  [cyan]{_escape(p['name'])}[/cyan]  [bold]{_escape(pname)}[/bold]  "
                    f"[dim]{_escape(p['project_path'])}  {p['updated_at'][:10]}[/dim]"
                )
        sys.exit(0)

    if getattr(args, "delete", False):
        if store.exists(args.delete):
            store.delete(args.delete)
            T.success(f"Project '{args.delete}' deleted.")
        else:
            T.error(f"Project '{args.delete}' not found.")
        sys.exit(0)

    # Default to launching the GUI server unless --cli is explicitly passed
    if not getattr(args, "cli", False):
        from .ide_server import start_gui_server
        start_gui_server(host="127.0.0.1", port=3000)
        sys.exit(0)

    T.print_banner(version=__version__, mode=args.mode)

    try:
        project = asyncio.run(startup_menu(store, args))
        asyncio.run(repl_loop(project, store, max_retries=args.max_retries))
    except KeyboardInterrupt:
        T.warning(_("repl_interrupted"))
        sys.exit(0)
    except T.AppExit:
        T.info(_("exiting"))
        sys.exit(0)


if __name__ == "__main__":
    main()
