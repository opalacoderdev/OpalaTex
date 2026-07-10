from opalatex import models_store


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
    assert [model["id"] for model in saved] == ["OpalaTexCloud", "ollama/new-model"]
