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
    assert [model["id"] for model in saved] == [
        "OpalaTexCloud",
        "OpalaTexCloudGemini35Flash",
        "ollama/new-model",
    ]


def test_load_models_updates_existing_cloud_model_names(tmp_path, monkeypatch):
    store_path = tmp_path / "models.json"
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", store_path)

    # Save legacy names in models.json
    models_store.save_models([
        {"id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Cloud", "api_key": "", "api_base": ""},
        {"id": "OpalaTexCloudGemini35Flash", "provider": "OpalaTex", "name": "OpalaTex Cloud Gemini 3.5 Flash (6x credits)", "api_key": "", "api_base": ""},
    ])

    loaded = models_store.load_models()
    cloud_map = {m["id"]: m["name"] for m in loaded}
    assert cloud_map["OpalaTexCloud"] == "OpalaTex Live"
    assert cloud_map["OpalaTexCloudGemini35Flash"] == "OpalaTex Flash (4x credits)"
