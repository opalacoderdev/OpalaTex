import json
import os
from pathlib import Path
from typing import Any, Dict, List

from .config import get_opalatex_home

_MODELS_STORE_PATH = Path(get_opalatex_home()) / "models.json"

_DEFAULT_MODELS = [
    # OpalaTex Cloud Model
    { "id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Cloud", "api_key": "", "api_base": "" },

    # OpenAI Models
    { "id": "openai/gpt-5.5", "provider": "openai", "name": "gpt-5.5", "api_key": "", "api_base": "" },
    { "id": "openai/gpt-5.5-pro", "provider": "openai", "name": "gpt-5.5-pro", "api_key": "", "api_base": "" },
    { "id": "openai/gpt-5.4", "provider": "openai", "name": "gpt-5.4", "api_key": "", "api_base": "" },
    { "id": "openai/gpt-5.4-pro", "provider": "openai", "name": "gpt-5.4-pro", "api_key": "", "api_base": "" },
    { "id": "openai/gpt-5-mini", "provider": "openai", "name": "gpt-5-mini", "api_key": "", "api_base": "" },
    { "id": "openai/gpt-5-nano", "provider": "openai", "name": "gpt-5-nano", "api_key": "", "api_base": "" },
    { "id": "openai/responses/gpt-5.5", "provider": "openai", "name": "responses/gpt-5.5", "api_key": "", "api_base": "" },
    { "id": "openai/responses/gpt-5-mini", "provider": "openai", "name": "responses/gpt-5-mini", "api_key": "", "api_base": "" },
    
    # Anthropic Models
    { "id": "anthropic/claude-opus-4-6", "provider": "anthropic", "name": "claude-opus-4-6", "api_key": "", "api_base": "" },
    { "id": "anthropic/claude-sonnet-4-6", "provider": "anthropic", "name": "claude-sonnet-4-6", "api_key": "", "api_base": "" },
    { "id": "anthropic/claude-opus-4-5-20251101", "provider": "anthropic", "name": "claude-opus-4-5-20251101", "api_key": "", "api_base": "" },
    { "id": "anthropic/claude-sonnet-4-5-20250929", "provider": "anthropic", "name": "claude-sonnet-4-5-20250929", "api_key": "", "api_base": "" },
    { "id": "anthropic/claude-opus-4-1-20250805", "provider": "anthropic", "name": "claude-opus-4-1-20250805", "api_key": "", "api_base": "" },
    { "id": "anthropic/claude-3-7-sonnet-20250219", "provider": "anthropic", "name": "claude-3-7-sonnet-20250219", "api_key": "", "api_base": "" },
    
    # Gemini Models
    { "id": "gemini/gemini-3-pro-preview", "provider": "gemini", "name": "gemini-3-pro-preview", "api_key": "", "api_base": "" },
    { "id": "gemini/gemini-3-flash-preview", "provider": "gemini", "name": "gemini-3-flash-preview", "api_key": "", "api_base": "" },
    { "id": "gemini/gemini-2.5-pro", "provider": "gemini", "name": "gemini-2.5-pro", "api_key": "", "api_base": "" },
    { "id": "gemini/gemini-2.5-flash", "provider": "gemini", "name": "gemini-2.5-flash", "api_key": "", "api_base": "" },
    { "id": "gemini/gemini-2.5-flash-preview-tts", "provider": "gemini", "name": "gemini-2.5-flash-preview-tts", "api_key": "", "api_base": "" },
    { "id": "gemini/gemini-2.5-pro-preview-tts", "provider": "gemini", "name": "gemini-2.5-pro-preview-tts", "api_key": "", "api_base": "" },
    
    # Ollama Models
    { "id": "ollama/gemma4:12b", "provider": "ollama", "name": "gemma4:12b", "api_key": "", "api_base": "http://localhost:11434/v1" },
    { "id": "ollama/gemma4:26b", "provider": "ollama", "name": "gemma4:26b", "api_key": "", "api_base": "http://localhost:11434/v1" },
    { "id": "ollama/llama3.1", "provider": "ollama", "name": "llama3.1", "api_key": "", "api_base": "http://localhost:11434/v1" },
    { "id": "ollama/gemma4:31b-cloud", "provider": "ollama", "name": "gemma4:31b-cloud", "api_key": "", "api_base": "https://ollama.com" },
    
    # Ollama Chat Models
    { "id": "ollama_chat/gemma4:12b", "provider": "ollama_chat", "name": "gemma4:12b", "api_key": "", "api_base": "http://localhost:11434" },
    { "id": "ollama_chat/deepseek-r1", "provider": "ollama_chat", "name": "deepseek-r1", "api_key": "", "api_base": "http://localhost:11434" },
    { "id": "ollama_chat/llama3.1", "provider": "ollama_chat", "name": "llama3.1", "api_key": "", "api_base": "http://localhost:11434" }
]

def load_models() -> List[Dict[str, Any]]:
    """Load models from the global store, populating defaults if missing or empty."""
    loaded_defaults = False
    models = []
    try:
        if _MODELS_STORE_PATH.exists():
            with open(_MODELS_STORE_PATH, "r", encoding="utf-8") as f:
                models = json.load(f)
    except Exception:
        pass
        
    if not isinstance(models, list) or len(models) == 0:
        models = list(_DEFAULT_MODELS)
        loaded_defaults = True
        
    # Ensure OpalaTexCloud is in the list
    has_opala_cloud = any(m.get("id") == "OpalaTexCloud" for m in models)
    if not has_opala_cloud:
        opala_cloud_model = { "id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Cloud", "api_key": "", "api_base": "" }
        models.insert(0, opala_cloud_model)
        loaded_defaults = True
        
    if loaded_defaults:
        save_models(models)
        
    return models

def save_models(models: List[Dict[str, Any]]) -> None:
    """Save models list to the global store."""
    _MODELS_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_MODELS_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(models, f, indent=2, ensure_ascii=False)

def get_model(model_id: str) -> Dict[str, Any] | None:
    """Get a specific model by ID."""
    models = load_models()
    for m in models:
        if m.get("id") == model_id:
            return m
    return None

def add_or_update_model(model_data: Dict[str, Any]) -> None:
    """Add a new model or update an existing one by ID.

    When editing a model whose ID changed, callers can pass ``previous_id`` to
    replace the old entry instead of appending a duplicate under the new ID.
    """
    if "id" not in model_data:
        raise ValueError("Model data must contain an 'id' field")
        
    models = load_models()
    model_data = dict(model_data)
    previous_id = model_data.pop("previous_id", None)
    model_id = model_data["id"]

    if previous_id and previous_id != model_id:
        for m in models:
            if m.get("id") == model_id:
                raise ValueError(f"Model '{model_id}' already exists")
    
    updated = False
    for i, m in enumerate(models):
        if m.get("id") == (previous_id or model_id):
            models[i] = model_data
            updated = True
            break
            
    if not updated:
        models.append(model_data)
        
    save_models(models)

def delete_model(model_id: str) -> bool:
    """Delete a model by ID. Returns True if deleted, False if not found."""
    models = load_models()
    initial_length = len(models)
    
    models = [m for m in models if m.get("id") != model_id]
    
    if len(models) < initial_length:
        save_models(models)
        return True
    return False
