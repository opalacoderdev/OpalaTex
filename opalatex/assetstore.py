"""AssetStore — local repository of reusable assets (skills and model configs).

Structure
---------
opalatex/assetstore/
    skills/
        <ID>.zip        — full skill directory tree
        <ID>.metadata   — YAML: id, type, name, desc
    modelconfigs/
        <ID>.zip        — single YAML file for the model config
        <ID>.metadata   — YAML: id, type, desc, model

Installation targets (relative to project root)
---------
skill       → <project>/.opalatex/skills/<name>/
modelconfig → <project>/.opalatex/modelsconfig/<provider>/<model_file>.yaml
"""

import os
import zipfile
from pathlib import Path
from typing import Optional

import yaml

# Root of the assetstore bundled with the package
_STORE_ROOT = Path(__file__).parent / "assetstore"

VALID_TYPES = {"skill", "modelconfig"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _store_dir(asset_type: str) -> Path:
    return _STORE_ROOT / (asset_type + "s")  # skills/ or modelconfigs/


def _parse_metadata(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _iter_assets(asset_type: str) -> list[dict]:
    """Return list of metadata dicts for all assets of the given type."""
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
    """True if desc matches the asset's id or desc field (case-insensitive)."""
    desc_l = desc.lower()
    return (
        meta.get("id", "").lower() == desc_l
        or meta.get("desc", "").lower() == desc_l
    )


def _model_to_path(model: str) -> tuple[str, str]:
    """'ollama/gpt-oss:latest' → ('ollama', 'gpt-oss__latest.yaml')"""
    _ALIASES = {"ollama_chat": "ollama"}
    if "/" in model:
        raw_provider, model_name = model.split("/", 1)
    else:
        raw_provider, model_name = "", model
    provider = _ALIASES.get(raw_provider, raw_provider)
    filename = model_name.replace(":", "__") + ".yaml"
    return provider, filename


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_assets(asset_type: Optional[str] = None) -> list[dict]:
    """Return all assets, optionally filtered by type."""
    types = [asset_type] if asset_type else list(VALID_TYPES)
    result = []
    for t in types:
        result.extend(_iter_assets(t))
    return result


def find_assets(asset_type: str, desc: str) -> list[dict]:
    """Return matching assets. desc='*' returns all of the type."""
    assets = _iter_assets(asset_type)
    if desc == "*":
        return assets
    return [a for a in assets if _match(a, desc)]


def install_asset(meta: dict, project_path: str) -> str:
    """Extract asset zip into the correct location inside project_path.

    Returns a human-readable summary of what was installed.
    """
    zip_path: Path = meta["_zip"]
    if not zip_path.exists():
        raise FileNotFoundError(f"Zip not found: {zip_path}")

    asset_type = meta.get("type", "")
    project = Path(os.path.abspath(project_path))

    if asset_type == "skill":
        dest = project / ".opalatex" / "skills"
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(dest)
        skill_name = meta.get("name", zip_path.stem)
        return f"skill '{skill_name}' installed at {dest / skill_name}"

    elif asset_type == "modelconfig":
        model = meta.get("model", "")
        if not model:
            raise ValueError(f"Asset {meta.get('id')} has no 'model' field in metadata")
        provider, filename = _model_to_path(model)
        dest_dir = project / ".opalatex" / "modelsconfig" / provider
        dest_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            yaml_files = [n for n in zf.namelist() if n.endswith('.yaml')]
            if len(yaml_files) != 1:
                raise ValueError(f"modelconfig zip must contain exactly one .yaml file, got: {yaml_files}")
            
            yaml_name = yaml_files[0]
            target = dest_dir / filename
            with zf.open(yaml_name) as source, open(target, "wb") as dest:
                import shutil
                shutil.copyfileobj(source, dest)
        return f"modelconfig for '{model}' installed at {target}"

    else:
        raise ValueError(f"Unknown asset type '{asset_type}'")


def register_asset(asset_type: str, source_path: str, metadata: dict) -> Path:
    """Package a local directory/file as an asset and register it in the store.

    source_path: directory (for skill) or .yaml file (for modelconfig)
    metadata: dict with at least id, type, desc, and name or model
    Returns the path of the created zip.
    """
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
