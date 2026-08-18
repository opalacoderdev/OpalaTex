"""AssetStore: local repository of reusable skill assets.

Structure
---------
opalatex/assetstore/
    skills/
        <ID>.zip        - full skill directory tree
        <ID>.metadata   - YAML: id, type, name, desc

Installation targets (relative to project root)
---------
skill -> <project>/.opalatex/skills/<name>/
"""

import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional

import yaml

_STORE_ROOT = Path(__file__).parent / "assetstore"

VALID_TYPES = {"skill"}


def _store_dir(asset_type: str) -> Path:
    return _STORE_ROOT / (asset_type + "s")


def _parse_metadata(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _iter_assets(asset_type: str) -> list[dict]:
    """Return metadata dictionaries for all assets of the given type."""
    d = _store_dir(asset_type)
    if not d.exists():
        return []
    results = []
    for meta_file in sorted(d.glob("*.metadata")):
        try:
            meta = _parse_metadata(meta_file)
            meta["_zip"] = meta_file.with_suffix(".zip")
            meta["_meta"] = meta_file
            results.append(meta)
        except Exception:
            continue
    return results


def _match(meta: dict, desc: str) -> bool:
    """Return True if desc matches the asset id or description."""
    desc_l = desc.lower()
    return (
        meta.get("id", "").lower() == desc_l
        or meta.get("desc", "").lower() == desc_l
    )


def list_assets(asset_type: Optional[str] = None) -> list[dict]:
    """Return all assets, optionally filtered by type."""
    types = [asset_type] if asset_type else list(VALID_TYPES)
    result = []
    for t in types:
        if t in VALID_TYPES:
            result.extend(_iter_assets(t))
    return result


def find_assets(asset_type: str, desc: str) -> list[dict]:
    """Return matching assets. desc='*' returns all assets of the type."""
    assets = _iter_assets(asset_type) if asset_type in VALID_TYPES else []
    if desc == "*":
        return assets
    return [a for a in assets if _match(a, desc)]


def resolve_asset_icon_path(meta: dict) -> Optional[Path]:
    """Return the absolute path to an asset's icon file, or None.

    The `icon` metadata field names a file expected next to the asset's
    `.metadata`/`.zip` pair in the store. Missing field, missing file, or an
    `icon` value that escapes the store directory all resolve to None so
    callers can fall back to a default icon.
    """
    icon_name = meta.get("icon")
    meta_path: Optional[Path] = meta.get("_meta")
    if not icon_name or not meta_path:
        return None
    store_dir = meta_path.parent.resolve()
    icon_path = (store_dir / icon_name).resolve()
    if not icon_path.is_relative_to(store_dir) or not icon_path.is_file():
        return None
    return icon_path


def installed_skill_dir(meta: dict, project_path: str) -> Optional[Path]:
    """Return the project-local install directory of a skill asset, or None.

    A skill installed into `<project>/.opalatex/skills/<name>/` shadows the
    bundled copy of the same name (see `skills.skill_search_dirs`), so it is the
    one that actually runs and the one an update has to replace.
    """
    if meta.get("type", "") != "skill":
        return None
    zip_path: Optional[Path] = meta.get("_zip")
    name = meta.get("name") or (zip_path.stem if zip_path else "")
    if not name:
        return None
    dest_root = (Path(os.path.abspath(project_path)) / ".opalatex" / "skills").resolve()
    candidate = (dest_root / name).resolve()
    # A crafted asset name must not point the caller at a directory outside the
    # project's skills folder -- the update path deletes what this returns.
    if not candidate.is_relative_to(dest_root) or candidate == dest_root:
        return None
    return candidate if candidate.is_dir() else None


def asset_matches_install(meta: dict, project_path: str) -> bool:
    """True when the project-local copy is identical to the catalog asset.

    False means the local copy has drifted -- an older catalog version, or files
    edited/added/removed in the project -- so the Skills Store can offer to
    refresh it. Missing local copy or missing zip is not a match.
    """
    local = installed_skill_dir(meta, project_path)
    zip_path: Optional[Path] = meta.get("_zip")
    if local is None or zip_path is None or not zip_path.exists():
        return False

    root = local.parent
    expected: set[Path] = set()
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = (root / info.filename).resolve()
            if not target.is_relative_to(local):
                continue
            expected.add(target)
            if not target.is_file() or target.stat().st_size != info.file_size:
                return False
            with zf.open(info) as packed, open(target, "rb") as installed:
                if packed.read() != installed.read():
                    return False

    # Files the local copy has and the asset does not count as drift too: an
    # update deletes them, so reporting "up to date" here would be a lie.
    present = {p.resolve() for p in local.rglob("*") if p.is_file()}
    return present == expected


def install_asset(meta: dict, project_path: str, replace: bool = False) -> str:
    """Extract a skill asset into project_path and return a summary.

    With *replace*, the existing project-local copy is deleted first, so files
    dropped from the asset since the last install do not survive the update.
    Plain extraction only overwrites the entries the zip still carries.
    """
    zip_path: Path = meta["_zip"]
    if not zip_path.exists():
        raise FileNotFoundError(f"Zip not found: {zip_path}")

    asset_type = meta.get("type", "")
    project = Path(os.path.abspath(project_path))

    if asset_type == "skill":
        dest = project / ".opalatex" / "skills"
        dest.mkdir(parents=True, exist_ok=True)
        replaced = False
        if replace:
            existing = installed_skill_dir(meta, project_path)
            if existing is not None:
                shutil.rmtree(existing)
                replaced = True
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(dest)
        skill_name = meta.get("name", zip_path.stem)
        verb = "updated" if replaced else "installed"
        return f"skill '{skill_name}' {verb} at {dest / skill_name}"

    raise ValueError(f"Unknown asset type '{asset_type}'")


def register_asset(asset_type: str, source_path: str, metadata: dict) -> Path:
    """Package a local skill directory as an asset and register it in the store."""
    if asset_type not in VALID_TYPES:
        raise ValueError(f"type must be one of {VALID_TYPES}")

    asset_id = metadata.get("id")
    if not asset_id:
        raise ValueError("metadata must have an 'id' field")

    store_dir = _store_dir(asset_type)
    store_dir.mkdir(parents=True, exist_ok=True)

    zip_path = store_dir / f"{asset_id}.zip"
    meta_path = store_dir / f"{asset_id}.metadata"

    source = Path(source_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        if source.is_dir():
            for f in sorted(source.rglob("*")):
                if f.is_file() and "__pycache__" not in str(f) and not f.name.endswith(".pyc"):
                    zf.write(f, f.relative_to(source.parent))
        else:
            zf.write(source, source.name)

    with open(meta_path, "w", encoding="utf-8") as f:
        yaml.dump(metadata, f, allow_unicode=True, default_flow_style=False)

    return zip_path
