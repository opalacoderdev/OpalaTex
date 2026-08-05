import uuid
from typing import List, Dict, Any, Optional
from .base import BaseArchivalMemory

try:
    import chromadb
except ImportError:
    chromadb = None  # type: ignore

class ChromaArchivalMemory(BaseArchivalMemory):
    """
    Archival Memory implementation using ChromaDB for semantic vector search.
    
    If persist_directory is provided, data is saved to disk. Otherwise, 
    an ephemeral in-memory database is used.
    """
    
    def __init__(self, collection_name: str = "archival", persist_directory: Optional[str] = None):
        if chromadb is None:
            raise ImportError("chromadb is required for ChromaArchivalMemory. Please install it with 'pip install chromadb'.")
            
        if persist_directory:
            self.client = chromadb.PersistentClient(path=persist_directory)
        else:
            self.client = chromadb.EphemeralClient()
            
        self.collection = self.client.get_or_create_collection(collection_name)

    def insert(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        doc_id = str(uuid.uuid4())
        self.collection.add(
            documents=[content],
            metadatas=[metadata] if metadata else None,
            ids=[doc_id]
        )

    def search(self, query: str, page: int = 1, page_size: int = 5) -> List[Dict[str, Any]]:
        if page < 1:
            page = 1
            
        # We query for enough results to cover the offset
        offset = (page - 1) * page_size
        n_results_to_fetch = offset + page_size
        
        results = self.collection.query(
            query_texts=[query],
            n_results=n_results_to_fetch
        )
        
        if not results or not results.get("documents"):
            return []
            
        docs = results["documents"][0]
        metas = results["metadatas"][0] if results.get("metadatas") else []
        
        # Paginate manually if Chroma doesn't support offset natively in query
        docs_page = docs[offset:offset+page_size]
        
        if metas:
            metas_page = metas[offset:offset+page_size]
        else:
            metas_page = [{}] * len(docs_page)
            
        return [{"content": d, "metadata": m} for d, m in zip(docs_page, metas_page)]
