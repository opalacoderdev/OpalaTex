import pytest

from opalatex import models_store
from opalatex.extensions import CloudExtensionInterface


def test_add_or_update_model_replaces_previous_id(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    models_store.save_models([
        {
            "id": "ollama/old-model",
            "provider": "ollama",
            "name": "old-model",
            "api_key": "",
            "api_base": "http://localhost:11434/v1",
        }
    ])

    models_store.add_or_update_model({
        "previous_id": "ollama/old-model",
        "id": "ollama/new-model",
        "provider": "ollama",
        "name": "new-model",
        "api_key": "",
        "api_base": "http://localhost:11434/v1",
    })

    saved = models_store.load_models()
    assert [model["id"] for model in saved] == [
        "ollama/new-model",
    ]
    assert saved[0]["supports_thinking"] is False


def test_load_models_defaults_supports_thinking_to_false(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    models_store.save_models([
        {
            "id": "ollama/test-model",
            "provider": "ollama",
            "name": "test-model",
            "api_key": "",
            "api_base": "http://localhost:11434/v1",
        }
    ])

    loaded = models_store.load_models()

    assert loaded[0]["supports_thinking"] is False


def test_load_models_filters_cloud_models_in_community_mode(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    # Save legacy names in models.json
    models_store.save_models([
        {"id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Cloud", "api_key": "", "api_base": ""},
        {"id": "OpalaTexCloudGemini35Flash", "provider": "OpalaTex", "name": "OpalaTex Cloud Gemini 3.5 Flash (6x credits)", "api_key": "", "api_base": ""},
    ])

    loaded = models_store.load_models()
    assert [m["id"] for m in loaded] == []


def test_load_models_updates_existing_cloud_model_names_when_cloud_extension_loaded(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    class FakeExtensionManager:
        has_cloud = True
        cloud = CloudExtensionInterface()

    monkeypatch.setattr(models_store, "get_extension_manager", lambda: FakeExtensionManager())

    # Save legacy names in models.json
    models_store.save_models([
        {"id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Cloud", "api_key": "", "api_base": ""},
        {"id": "OpalaTexCloudGemini35Flash", "provider": "OpalaTex", "name": "OpalaTex Cloud Gemini 3.5 Flash (6x credits)", "api_key": "", "api_base": ""},
    ])

    loaded = models_store.load_models()
    cloud_map = {m["id"]: m["name"] for m in loaded}
    assert cloud_map["OpalaTexCloud"] == "OpalaTex Live"
    assert cloud_map["OpalaTexCloudGemini35Flash"] == "OpalaTex Flash (4x credits)"


def test_load_models_starts_with_an_empty_catalog(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    assert models_store.load_models() == []


def test_load_local_ollama_models_adds_only_unconfigured_models(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)
    models_store.save_models([
        {
            "id": "ollama/already-configured:latest",
            "provider": "ollama",
            "name": "already-configured:latest",
            "api_key": "",
            "api_base": "http://localhost:11434/v1",
        }
    ])
    monkeypatch.setattr(
        "opalatex.ollama_manager.check_ollama_status",
        lambda: {"installed": True},
    )

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"models":[{"name":"already-configured:latest"},{"name":"new-model:latest"}]}'

    monkeypatch.setattr(models_store.urllib_request, "urlopen", lambda *_args, **_kwargs: FakeResponse())

    added = models_store.load_local_ollama_models()

    assert added == [{
        "id": "ollama/new-model:latest",
        "provider": "ollama",
        "name": "new-model:latest",
        "api_key": "",
        "api_base": "http://localhost:11434/v1",
        "supports_thinking": False,
    }]
    assert [model["id"] for model in models_store.load_models()] == [
        "ollama/already-configured:latest",
        "ollama/new-model:latest",
    ]


def test_load_local_ollama_models_requires_ollama_installation(monkeypatch):
    monkeypatch.setattr(
        "opalatex.ollama_manager.check_ollama_status",
        lambda: {"installed": False},
    )

    with pytest.raises(models_store.LocalOllamaNotInstalledError):
        models_store.load_local_ollama_models()