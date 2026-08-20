"""The skill catalog must list exactly what run_skill will accept.

The orchestrator's prompt carries a `## Available skills` section built from the
active skills. It used to include the orchestrator's own entry, which is not a
delegation target -- and since `skills/chat-orchestrator/SKILL.md` carries no
frontmatter, that entry rendered as a bare `- chat-orchestrator:` with nothing
after the colon. A blank slot in a list of what is available is an invitation to
fill it in: one model enumerated its own tools (`create_plan`, `search_code`,
`read_file`, ...) as if they were skills it could delegate to.
"""
import asyncio

import pytest

from opalatex.memgpt_runtime import (
    CHAT_ORCHESTRATOR_SKILL,
    build_run_skill_tool,
    chat_orchestrator_system_prompt,
)
from opalatex.project import ProjectData
from opalatex.skills import active_skills, level1_metadata, MANDATORY_SKILLS


def _catalog_section(tmp_path) -> str:
    """Return the `## Available skills` block of the real system prompt."""
    project = ProjectData(
        name="t", project_name="t",
        project_path=str(tmp_path), model="ollama/some-model", mode="auto",
    )
    prompt = chat_orchestrator_system_prompt(project, None)
    # The body text quotes the heading ("the `## Available skills` section of this
    # prompt is..."), so match the heading line itself, not the first mention.
    heading = "\n## Available skills (call run_skill with the skill name)\n"
    start = prompt.index(heading)
    body = prompt[start + len(heading):]
    lines = []
    for line in body.splitlines():
        if line.startswith("##") or (line.strip() and not line.startswith(("- ", "("))):
            break
        if line.strip():
            lines.append(line)
    return "\n".join(lines)


def test_the_real_system_prompt_never_offers_the_orchestrator_to_itself(tmp_path):
    section = _catalog_section(tmp_path)
    assert "command-line" in section
    assert CHAT_ORCHESTRATOR_SKILL not in section
    # The bare "- chat-orchestrator:" entry, description-less, is what invited a
    # model to fill the blank with its own tool names.
    assert f"- {CHAT_ORCHESTRATOR_SKILL}:" not in section


class _Project:
    def __init__(self, project_path, mode="auto"):
        self.project_path = project_path
        self.mode = mode
        self.model = "test-model"
        self.worker_model = ""


class _MemGPT:
    internal_history: list = []


def _catalog(project_path=""):
    """Render the catalog the way build_chat_orchestrator does."""
    skills = active_skills(project_path)
    targets = [s for s in skills if s.get("name") != CHAT_ORCHESTRATOR_SKILL]
    return level1_metadata(targets)


def test_command_line_is_active_by_default_for_every_project(tmp_path):
    """No skills.yaml at all: command-line must still be there to delegate to."""
    names = {s["name"] for s in active_skills(str(tmp_path))}
    assert "command-line" in names
    assert "command-line" in MANDATORY_SKILLS


def test_the_catalog_does_not_offer_the_orchestrator_as_a_target():
    catalog = _catalog()
    assert CHAT_ORCHESTRATOR_SKILL not in catalog
    assert "command-line" in catalog


def test_no_catalog_entry_is_left_with_an_empty_description():
    """An entry rendered as `- name:` reads as a skill whose purpose is unknown."""
    for line in _catalog().splitlines():
        assert line.startswith("- "), line
        name, _, description = line[2:].partition(":")
        assert description.strip(), f"catalog entry '{name}' has no description"


def test_every_listed_skill_is_one_run_skill_can_resolve(tmp_path):
    from opalatex.skills import find_skill_dir
    for line in _catalog(str(tmp_path)).splitlines():
        name = line[2:].partition(":")[0].strip()
        assert find_skill_dir(name, str(tmp_path)) is not None, name


def _run_skill(project_path, mode="auto"):
    project = _Project(project_path, mode=mode)
    return build_run_skill_tool(
        _MemGPT(), project_path, project_model="test-model", _project_ref=project,
    )


def test_delegating_to_itself_is_refused_with_a_usable_alternative(tmp_path):
    tool = _run_skill(str(tmp_path))
    out = asyncio.run(tool._func(CHAT_ORCHESTRATOR_SKILL, "do something"))

    assert "[ERROR]" in out
    assert "is you, not a delegation target" in out
    # It must still say where the work can go instead.
    assert "command-line" in out
    # And never list itself among those targets.
    assert out.count(CHAT_ORCHESTRATOR_SKILL) == 1


def test_an_invented_skill_name_is_told_that_tools_are_not_skills(tmp_path):
    tool = _run_skill(str(tmp_path))
    out = asyncio.run(tool._func("read_file", "read the calendar"))

    assert "[ERROR]" in out
    assert "was not found / is not active" in out
    assert "are tools you call" in out
    assert "command-line" in out
    assert CHAT_ORCHESTRATOR_SKILL not in out


@pytest.mark.parametrize("variant", [
    "SKILL.md", "SKILL.delegate.md", "SKILL.light.md", "SKILL.light-delegate.md",
])
def test_every_orchestrator_prompt_says_the_catalog_is_not_its_toolset(variant):
    import os
    base = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "skills", "chat-orchestrator",
    )
    with open(os.path.join(base, variant), encoding="utf-8") as f:
        text = f.read()
    assert "not a delegation target" in text, variant
    assert "create_plan" in text, variant
