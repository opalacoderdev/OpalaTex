"""Regression tests for the single source of truth of the global model catalog.

A model registered anywhere in the UI (onboarding, Edit Models, Add Provider)
must immediately be listed everywhere else, in particular in the chat toolbar
model pickers. That only holds while every surface reads the catalog from
`ModelCatalogProvider` instead of keeping a private snapshot of
`/api/settings/models`: the onboarding flow used to fetch its own copy, so a
model registered there stayed invisible in the chat until the app was reloaded.

Covers:
1. Only the provider talks to the models endpoint.
2. The consumers of the catalog go through `useModelCatalog`.
3. Project model fields are catalog pickers, not free-text inputs, so a project
   can only reference an id the catalog knows about.
"""

from pathlib import Path

import pytest

GUI_SRC = Path(__file__).resolve().parents[1] / "gui_src" / "src"
PROVIDER = GUI_SRC / "contexts" / "ModelCatalogProvider.jsx"
MODELS_ENDPOINT = "/api/settings/models"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_only_the_provider_calls_the_models_endpoint():
    offenders = sorted(
        str(path.relative_to(GUI_SRC))
        for path in GUI_SRC.rglob("*.jsx")
        if path != PROVIDER and MODELS_ENDPOINT in _read(path)
    )
    offenders += sorted(
        str(path.relative_to(GUI_SRC))
        for path in GUI_SRC.rglob("*.js")
        if MODELS_ENDPOINT in _read(path)
    )

    assert offenders == [], (
        "The model catalog must be read through ModelCatalogProvider; "
        f"these files fetch {MODELS_ENDPOINT} directly: {offenders}"
    )


@pytest.mark.parametrize(
    "relative_path",
    ["App.jsx", "components/modals/OnboardingModal.jsx"],
)
def test_catalog_consumers_use_the_shared_hook(relative_path):
    source = _read(GUI_SRC / relative_path)
    assert "useModelCatalog" in source


@pytest.mark.parametrize(
    "relative_path",
    [
        "components/modals/NewProjectModal.jsx",
        "components/modals/EditProjectModal.jsx",
    ],
)
def test_project_dialogs_pick_models_from_the_catalog(relative_path):
    source = _read(GUI_SRC / relative_path)

    assert "ModelSelect" in source
    # A free-text model field lets a project store an id the catalog does not
    # have, which is exactly the mismatch these dialogs must not create.
    assert "datalist" not in source
