import os
from pathlib import Path

# Singleton para evitar carregar o ChromaDB múltiplas vezes
_chroma_client = None

def _get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        try:
            import chromadb
        except ImportError:
            raise ImportError("Please install chromadb: pip install chromadb")
            
        from .config import get_opalatex_home
        
        # O banco será salvo no mesmo diretório global do projects.db
        # ex: ~/.opalatex/chroma
        db_path = Path(get_opalatex_home()) / "chroma"
        db_path.mkdir(parents=True, exist_ok=True)
        
        _chroma_client = chromadb.PersistentClient(path=str(db_path))
    return _chroma_client

def get_collection(project_name: str):
    client = _get_chroma_client()
    # Nomes de coleções no Chroma precisam ser alfanuméricos curtos
    safe_name = "".join(c if c.isalnum() else "_" for c in project_name).strip("_")
    if not safe_name:
        safe_name = "default_project"
    return client.get_or_create_collection(name=safe_name)

def append_to_archival(project_name: str, message_id: str, role: str, content: str, timestamp: str, chat_id: str = None):
    """
    Adiciona uma mensagem ao Archival Memory (ChromaDB) do projeto.
    """
    if not content or not content.strip():
        return
        
    collection = get_collection(project_name)
    
    metadata = {
        "role": role,
        "timestamp": timestamp
    }
    if chat_id:
        metadata["chat_id"] = chat_id
    
    collection.add(
        documents=[content],
        metadatas=[metadata],
        ids=[f"{message_id}"]
    )

def search_archival(project_name: str, query: str, limit: int = 5, chat_id: str = None) -> list[dict]:
    """
    Pesquisa o histórico usando similaridade de cosseno via ChromaDB.
    """
    try:
        collection = get_collection(project_name)
        kwargs = {
            "query_texts": [query],
            "n_results": limit
        }
        if chat_id:
            kwargs["where"] = {"chat_id": chat_id}
            
        results = collection.query(**kwargs)
        
        out = []
        if results and "documents" in results and results["documents"]:
            docs = results["documents"][0]
            metas = results["metadatas"][0] if "metadatas" in results else []
            for i, doc in enumerate(docs):
                meta = metas[i] if i < len(metas) else {}
                out.append({
                    "content": doc,
                    "role": meta.get("role", "unknown"),
                    "timestamp": meta.get("timestamp", "")
                })
        return out
    except Exception as e:
        import traceback
        traceback.print_exc()
        return []

def clear_archival(project_name: str):
    """
    Exclui a coleção do ChromaDB associada ao projeto, limpando completamente a memória arquivada.
    """
    try:
        client = _get_chroma_client()
        safe_name = "".join(c if c.isalnum() else "_" for c in project_name).strip("_")
        if not safe_name:
            safe_name = "default_project"
        try:
            client.delete_collection(name=safe_name)
        except ValueError:
            pass
    except Exception as e:
        if "does not exist" not in str(e).lower() and "not found" not in str(e).lower():
            print(f"Error clearing archival memory: {e}")

def clear_archival_chat(project_name: str, chat_id: str):
    """
    Exclui mensagens do ChromaDB de um chat específico.
    """
    try:
        collection = get_collection(project_name)
        collection.delete(where={"chat_id": chat_id})
    except Exception as e:
        pass
