import os


# ===========================================================================
# Skills-oriented architecture (target design) — see docs/specs/06
# ---------------------------------------------------------------------------
# A skill is a DIRECTORY containing a SKILL.md (Anthropic format). Frontmatter
# carries only `name`, `description`, and an optional `model`. Discovery loads
# Level-1 metadata (name + description) into the MemGPT system prompt; the body
# and bundled resources/scripts (Level 2/3) are read on demand by the sub-agent.
# ===========================================================================

# The chat-orchestrator skill is always loaded regardless of skills.yaml.
MANDATORY_SKILLS = ("chat-orchestrator", "view-editor", "command-line")

# Directory name of the skill manifest file inside each skill directory.
SKILL_MANIFEST = "SKILL.md"


def skill_search_dirs(project_path: str = "") -> list[str]:
    """Return directories that may contain skill subdirectories, in priority order.

    Target design (docs/specs/06 §5):
      1. <project>/skills/
      2. <project>/.opalatex/skills/
      3. ~/.opalatex/skills/
      4. <package>/skills/  and  <repo-root>/skills/  (bundled / mandatory)
    """
    dirs: list[str] = []
    if project_path:
        dirs.append(os.path.join(project_path, "skills"))
        dirs.append(os.path.join(project_path, ".opalatex", "skills"))
    dirs.append(os.path.expanduser("~/.opalatex/skills"))
    package_dir = os.path.dirname(os.path.abspath(__file__))
    dirs.append(os.path.join(package_dir, "skills"))
    repo_root = os.path.dirname(package_dir)
    dirs.append(os.path.join(repo_root, "skills"))
    # De-duplicate while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for d in dirs:
        ad = os.path.abspath(d)
        if ad not in seen:
            seen.add(ad)
            out.append(d)
    return out


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a SKILL.md into (frontmatter dict, body).

    Accepts standard YAML frontmatter delimited by leading/trailing `---`.
    Only flat `key: value` pairs are read (name, description, model); this avoids
    a hard YAML dependency for the common case. Returns ({}, text) when absent.
    """
    fm: dict[str, str] = {}
    stripped = text.lstrip("﻿")  # tolerate BOM
    if not stripped.startswith("---"):
        return fm, text
    # Find the closing delimiter line
    lines = stripped.splitlines()
    if not lines or lines[0].strip() != "---":
        return fm, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return fm, text
    for line in lines[1:end]:
        if not line.strip() or ":" not in line:
            continue
        key, _, val = line.partition(":")
        fm[key.strip().lower()] = val.strip()
    body = "\n".join(lines[end + 1:]).strip()
    return fm, body


def parse_skill_md(skill_dir: str) -> dict | None:
    """Parse a skill directory's SKILL.md into a metadata dict, or None.

    Returned dict:
      name, description, model (optional, "" if absent),
      dir (absolute path to the skill directory),
      manifest (absolute path to SKILL.md),
      body (Level-2 instructions text).
    The directory name is the canonical fallback for `name`.
    """
    manifest = os.path.join(skill_dir, SKILL_MANIFEST)
    if not os.path.isfile(manifest):
        return None
    try:
        with open(manifest, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return None
    fm, body = _parse_frontmatter(text)
    name = fm.get("name") or os.path.basename(os.path.normpath(skill_dir))
    description = fm.get("description", "")
    model = fm.get("model", "")
    extends = fm.get("extends", "")
    return {
        "name": name,
        "description": description,
        "model": model,
        "extends": extends,
        "dir": os.path.abspath(skill_dir),
        "manifest": os.path.abspath(manifest),
        "body": body,
    }


def discover_skills(project_path: str = "") -> list[dict]:
    """Discover all skill directories (containing SKILL.md) across search dirs.

    First occurrence of a skill name wins (project skills shadow bundled ones).
    Returns a list of metadata dicts (see parse_skill_md).
    """
    # Read explicit skill declarations; None means no skills.yaml (load all except store).
    declared = read_skills_yaml(project_path)  # list or None
    found: list[dict] = []
    seen_names: set[str] = set()
    for base in skill_search_dirs(project_path):
        if not os.path.isdir(base):
            continue
        for entry in sorted(os.listdir(base)):
            skill_dir = os.path.join(base, entry)
            if not os.path.isdir(skill_dir):
                continue
            meta = parse_skill_md(skill_dir)
            if meta is None or meta["name"] in seen_names:
                continue
            seen_names.add(meta["name"])
            found.append(meta)
    return found


def read_skills_yaml(project_path: str) -> list[str] | None:
    """Return the list of skill names declared in <project>/skills.yaml, or None.

    None means the file is absent → caller loads all discovered skills.
    An empty/!malformed file yields an empty list → only mandatory skills load.
    """
    path = os.path.join(project_path, "skills.yaml")
    if not os.path.isfile(path):
        return None
    try:
        import yaml
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        declared = data.get("skills", []) if isinstance(data, dict) else []
        return [str(s).strip() for s in declared if str(s).strip()]
    except Exception:
        return []


def write_skills_yaml(project_path: str, skill_names: list[str]) -> None:
    """Write the active skill set to <project>/skills.yaml.

    skills.yaml is the single source of truth for which skills' Level-1 metadata
    the MemGPT loads (docs/specs/06 §5). Mandatory skills are always implied; we
    do not persist them here.
    """
    import yaml
    declared = [s for s in dict.fromkeys(skill_names) if s not in MANDATORY_SKILLS]
    os.makedirs(project_path, exist_ok=True)
    path = os.path.join(project_path, "skills.yaml")
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump({"skills": declared}, f, allow_unicode=True, sort_keys=False)


def add_skill_to_project(project_path: str, skill_name: str) -> tuple[bool, str]:
    """Add a skill to the project's skills.yaml. Returns (changed, message)."""
    skill_dir = find_skill_dir(skill_name, project_path)
    if skill_dir is None:
        return False, f"skill '{skill_name}' not found in any search dir."
    if skill_name in MANDATORY_SKILLS:
        return False, f"skill '{skill_name}' is always active (mandatory)."
        
    meta = parse_skill_md(skill_dir)
    if meta and meta.get("extends"):
        parent_name = meta["extends"]
        active = [s["name"] for s in active_skills(project_path)]
        if parent_name not in active:
            return False, f"Cannot add skill '{skill_name}' because it extends '{parent_name}', which is not active."
            
    # Absent skills.yaml means "only mandatory active" → start from an empty set.
    declared = read_skills_yaml(project_path) or []
    if skill_name in declared:
        return False, f"skill '{skill_name}' is already active."
    declared.append(skill_name)
    write_skills_yaml(project_path, declared)
    return True, f"skill '{skill_name}' added."


def remove_skill_from_project(project_path: str, skill_name: str) -> tuple[bool, str]:
    """Remove a skill from the project's skills.yaml. Returns (changed, message)."""
    if skill_name in MANDATORY_SKILLS:
        return False, f"skill '{skill_name}' is mandatory and cannot be removed."
    declared = read_skills_yaml(project_path) or []
    if skill_name not in declared:
        return False, f"skill '{skill_name}' is not active."
    declared = [s for s in declared if s != skill_name]
    write_skills_yaml(project_path, declared)
    return True, f"skill '{skill_name}' removed."


def active_skills(project_path: str = "") -> list[dict]:
    """Return the skills active for a project.

    A project only loads the mandatory skills plus the ones it explicitly opts into
    via <project>/skills.yaml. This keeps new projects minimal — no development skill
    is loaded unless the user adds it (with /addskill or by listing it in skills.yaml).

    Rules:
      - Mandatory skills (chat-orchestrator) are always active.
      - No skills.yaml (or empty) → only the mandatory skills.
      - With skills.yaml → mandatory + the declared skills.
    """
    discovered = discover_skills(project_path)
    declared = read_skills_yaml(project_path) if project_path else None
    allowed = set(MANDATORY_SKILLS) | set(declared or [])
    return [s for s in discovered if s["name"] in allowed]


def level1_metadata(skills: list[dict]) -> str:
    """Render Level-1 metadata (name + description) for the MemGPT system prompt."""
    return "\n".join(f"- {s['name']}: {s['description']}".rstrip() for s in skills)


def find_skill_dir(skill_name: str, project_path: str = "") -> str | None:
    """Return the absolute path of a skill directory by name, or None."""
    for s in discover_skills(project_path):
        if s["name"] == skill_name:
            return s["dir"]
    return None
