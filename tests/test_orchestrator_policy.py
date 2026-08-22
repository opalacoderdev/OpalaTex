"""Tests for the orchestrator tool policy (direct/delegate).

The policy decides whether the chat orchestrator gets the workspace action
tools -- file writes *and* command execution, the same set a skill worker gets
-- or has to route every change through `run_skill`. It is a per-model catalog field
(`opalatex/models_store.py`) resolved by `config.model_orchestrator_policy`, and
it is deliberately separate from `prompt_profile`: the profile controls prompt
verbosity, the policy controls write authority, and "light prompt + delegate
writes" has to remain expressible.

Enforcement is tool-list composition in `build_chat_orchestrator`, not the mode
gate in `opalatex_tool` -- that gate wraps the same function objects the worker
calls, so restricting writes there would disarm the worker too.
"""

import os

import pytest

from opalatex.memgpt_runtime import (
    build_chat_orchestrator,
    _orchestrator_body_variant,
)
from opalatex.project import ProjectData


WRITE_TOOLS = {
    "write_file",
    "write_content_pos",
    "replace_content_range",
    "create_docx_file",
    "create_pptx_file",
}

# Command execution is part of the same authority as writing: an orchestrator
# allowed to rewrite main.tex but not to run pdflatex on it holds half an
# authority and has to delegate mid-task anyway.
EXEC_TOOLS = {
    "run_command",
    "run_python_script",
    "run_background_command",
    "run_interactive_command",
}


@pytest.fixture(autouse=True)
def _restore_terminal_flag():
    """Keep the global terminal-access flag from leaking between tests."""
    from opalatex import tools

    original = tools._ORCHESTRATOR_HAS_TERMINAL
    yield
    tools.set_orchestrator_terminal_access(original)


def _catalog(tmp_path, monkeypatch, model_id, **fields):
    """Register *model_id* in an isolated model catalog and return a project."""
    from opalatex import models_store

    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", tmp_path / "models_store.json")
    models_store.add_or_update_connection(
        {"id": "c1", "label": "c", "provider": "ollama", "api_key": "", "api_base": ""}
    )
    models_store.add_or_update_model(
        {"id": model_id, "connection_id": "c1", "name": model_id.split("/", 1)[-1], **fields}
    )
    return ProjectData(
        name="t", project_name="t",
        project_path=str(tmp_path), model=model_id, mode="auto",
    )


def _tool_names(project):
    return {getattr(t, "name", None) for t in build_chat_orchestrator(project, None).tools}


# ── The bug this policy work started from ────────────────────────────────────

def test_direct_orchestrator_can_create_a_file(tmp_path, monkeypatch):
    """Regression: the orchestrator had no way to create a file.

    With only write_content_pos and replace_content_range -- both of which
    require an existing file -- a model asked to create one had no valid call to
    make, and reached for write_content_pos, which fails with "file not found".
    """
    project = _catalog(tmp_path, monkeypatch, "ollama/direct-model")
    assert "write_file" in _tool_names(project)


def test_unregistered_model_defaults_to_direct_with_write_file(tmp_path, monkeypatch):
    """A model absent from the catalog keeps the shipped behavior, plus write_file."""
    from opalatex import models_store

    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", tmp_path / "models_store.json")
    project = ProjectData(
        name="t", project_name="t",
        project_path=str(tmp_path), model="ollama/never-registered", mode="auto",
    )
    assert WRITE_TOOLS <= _tool_names(project)


# ── Tool composition per policy ──────────────────────────────────────────────

def test_direct_policy_keeps_every_write_tool(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    assert WRITE_TOOLS <= _tool_names(project)


def test_delegate_policy_withholds_every_write_tool(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    names = _tool_names(project)
    assert not (WRITE_TOOLS & names), f"delegate orchestrator still holds {WRITE_TOOLS & names}"


def test_delegate_policy_keeps_reading_and_delegation(tmp_path, monkeypatch):
    """Withholding writes must not cost the orchestrator its ability to work."""
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    names = _tool_names(project)
    assert {
        "run_skill", "read_file", "read_content_pos", "search_code",
        "get_project_overview", "ask_question", "create_plan",
    } <= names
    # Core-memory writes are not file writes and stay available.
    assert {"read_core_memory", "append_core_memory"} <= names


def test_direct_policy_grants_command_execution(tmp_path, monkeypatch):
    """Regression: a direct orchestrator could write files but not run anything.

    Compiling, testing, renaming and deleting all needed a run_skill round-trip
    to `command-line`, which is exactly the delegation loop the policy exists to
    avoid for a model capable of doing the work itself.
    """
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    assert EXEC_TOOLS <= _tool_names(project)


def test_direct_policy_matches_the_worker_action_set(tmp_path, monkeypatch):
    """Both roles compose from `tools.get_workspace_action_tools()`.

    Asserted as a set identity rather than a list of names so a tool added to
    the worker can never silently skip the direct orchestrator again.
    """
    from opalatex.tools import get_workspace_action_tools

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    action_names = {t.name for t in get_workspace_action_tools()}

    assert action_names == WRITE_TOOLS | EXEC_TOOLS | {"export_tex_to_docx"}
    assert action_names <= _tool_names(project)


def test_delegate_policy_withholds_command_execution(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    names = _tool_names(project)
    assert not (EXEC_TOOLS & names), f"delegate orchestrator still holds {EXEC_TOOLS & names}"


@pytest.mark.parametrize("tool_name,args", [
    ("run_command", ("rm -rf build",)),
    ("run_python_script", ("script.py",)),
    ("run_background_command", ("npm run dev",)),
    ("run_interactive_command", ("npm init",)),
])
def test_execution_tools_stay_unsafe_for_the_orchestrator(tmp_path, tool_name, args):
    """Granting the tools must not weaken the mode gate.

    The gate in `opalatex_tool` wraps the same function objects for both roles,
    so a direct orchestrator inherits plan-mode refusal and edit-mode
    confirmation unchanged -- these tools are declared is_safe=False.
    """
    import asyncio
    from types import SimpleNamespace
    import opalatex.tools as tools

    tools.set_project_context(SimpleNamespace(project_path=str(tmp_path), mode="plan"))
    tool = getattr(tools, tool_name)
    raw = getattr(tool, "_func", None) or tool
    result = asyncio.run(raw(*args))

    assert result.startswith("Execution blocked: In 'plan' mode")


# ── Recovery advice follows the toolset, not the role ────────────────────────

def test_direct_orchestrator_is_told_to_convert_documents_itself(tmp_path, monkeypatch):
    """Guidance must name a route this caller can take (PROJECT_DESIGN 2.6)."""
    from opalatex.tools import _binary_read_error

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    build_chat_orchestrator(project, None)

    message = _binary_read_error(str(tmp_path / "data.xls"))
    assert "run_command" in message
    assert "command-line" not in message


def test_delegate_orchestrator_is_still_sent_to_the_command_line_skill(tmp_path, monkeypatch):
    from opalatex.tools import _binary_read_error

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    build_chat_orchestrator(project, None)

    message = _binary_read_error(str(tmp_path / "data.xls"))
    assert "'command-line'" in message
    assert "no terminal tool" in message


def test_worker_advice_ignores_the_orchestrator_policy(tmp_path, monkeypatch):
    """A worker always has run_command, whatever the orchestrator was granted."""
    import opalatex.tools as tools

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    build_chat_orchestrator(project, None)
    tools.set_worker_context(True)
    try:
        message = tools._binary_read_error(str(tmp_path / "data.xls"))
    finally:
        tools.set_worker_context(False)

    assert "You have run_command" in message


def test_delegate_policy_does_not_disarm_the_worker(tmp_path, monkeypatch):
    """The policy is orchestrator-scoped: workers must still be able to write.

    A worker has no run_skill and nothing to delegate to, so if the delegate
    policy leaked into the shared tool registry nothing could write at all.
    """
    _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    from opalatex.tools import get_available_tools

    worker_names = {t.name for t in get_available_tools()}
    assert (WRITE_TOOLS | EXEC_TOOLS) <= worker_names


# ── The two axes stay independent ────────────────────────────────────────────

def test_policy_and_profile_are_independent(tmp_path, monkeypatch):
    """"light prompt + delegate writes" is the combination worth protecting."""
    project = _catalog(
        tmp_path, monkeypatch, "ollama/small-local",
        prompt_profile="light", orchestrator_policy="delegate",
    )
    agent = build_chat_orchestrator(project, None)
    names = {getattr(t, "name", None) for t in agent.tools}

    assert not (WRITE_TOOLS & names)
    assert "Mode: auto." in agent.system_prompt  # light mode-instructions
    assert "\U0001F6A8 **SYSTEM ALERT" not in agent.system_prompt


def test_light_profile_still_writes_directly_by_default(tmp_path, monkeypatch):
    """Choosing the light profile must not imply delegation."""
    project = _catalog(tmp_path, monkeypatch, "ollama/m", prompt_profile="light")
    assert WRITE_TOOLS <= _tool_names(project)


# ── Body variant selection ───────────────────────────────────────────────────

def _orchestrator_skill_dir():
    from opalatex.memgpt_runtime import CHAT_ORCHESTRATOR_SKILL
    from opalatex.skills import find_skill_dir

    skill_dir = find_skill_dir(CHAT_ORCHESTRATOR_SKILL, "")
    assert skill_dir, "chat-orchestrator skill must be discoverable"
    return skill_dir


@pytest.mark.parametrize(
    "profile,policy,expected",
    [
        ("full", "direct", "full"),
        ("light", "direct", "light"),
        ("full", "delegate", "delegate"),
        ("light", "delegate", "light-delegate"),
    ],
)
def test_body_variant_selection(profile, policy, expected):
    assert _orchestrator_body_variant(_orchestrator_skill_dir(), profile, policy) == expected


def test_body_variant_falls_back_when_the_specific_file_is_missing(tmp_path):
    """A missing light-delegate body falls back to the delegate one.

    Delegation rules matter more than condensation, so the policy-specific body
    outranks the profile-specific one on the way down.
    """
    (tmp_path / "SKILL.md").write_text("canonical", encoding="utf-8")
    (tmp_path / "SKILL.light.md").write_text("condensed", encoding="utf-8")
    (tmp_path / "SKILL.delegate.md").write_text("no writing", encoding="utf-8")

    assert _orchestrator_body_variant(str(tmp_path), "light", "delegate") == "delegate"
    # With no delegate body at all it degrades to the profile body; the prompt
    # still carries the policy statement built in chat_orchestrator_system_prompt.
    os.remove(tmp_path / "SKILL.delegate.md")
    assert _orchestrator_body_variant(str(tmp_path), "light", "delegate") == "light"


def test_delegate_body_forbids_direct_editing(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    prompt = build_chat_orchestrator(project, None).system_prompt

    assert "no file-writing tools" in prompt
    # The instruction the full body carries must not survive into the delegate one.
    assert "Do not spawn a worker for a one-line change" not in prompt


def test_direct_body_documents_write_file(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    prompt = build_chat_orchestrator(project, None).system_prompt

    assert "write_file" in prompt


# ── The no-delegation-target guard ───────────────────────────────────────────

def test_delegate_without_any_target_says_so(tmp_path, monkeypatch):
    """With no delegatable skill, the prompt must state the blocker.

    `command-line` is mandatory and normally fills this role, so this only
    happens when skill discovery comes up short. The policy is not silently
    downgraded to "direct" -- that would hide the real cause.
    """
    import opalatex.memgpt_runtime as runtime

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    monkeypatch.setattr(runtime, "active_skills", lambda _p: [{"name": "chat-orchestrator", "description": ""}])

    prompt = build_chat_orchestrator(project, None).system_prompt
    assert "Writing is currently impossible" in prompt
    assert "/addskill" in prompt


def test_delegate_with_a_target_has_no_blocker_notice(tmp_path, monkeypatch):
    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="delegate")
    prompt = build_chat_orchestrator(project, None).system_prompt
    assert "Writing is currently impossible" not in prompt


def test_direct_policy_never_shows_the_blocker_notice(tmp_path, monkeypatch):
    import opalatex.memgpt_runtime as runtime

    project = _catalog(tmp_path, monkeypatch, "ollama/m", orchestrator_policy="direct")
    monkeypatch.setattr(runtime, "active_skills", lambda _p: [{"name": "chat-orchestrator", "description": ""}])

    prompt = build_chat_orchestrator(project, None).system_prompt
    assert "Writing is currently impossible" not in prompt


def test_fallback_body_is_policy_aware(monkeypatch):
    """The no-SKILL.md safety net must not hand a delegate agent write rules."""
    import opalatex.memgpt_runtime as runtime

    monkeypatch.setattr(runtime, "find_skill_dir", lambda *a, **k: None)

    direct = runtime._chat_orchestrator_body("/tmp/x", "full", "direct")
    delegate = runtime._chat_orchestrator_body("/tmp/x", "full", "delegate")

    assert "write_file is the only tool that creates a new file" in direct
    assert "You have NO file-writing tools" in delegate
    assert "every edit goes to a worker" in delegate
