from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class BaseArchivalMemory(ABC):
    """
    Abstract interface for Archival Memory (Long-term semantic storage).
    
    This memory is used for storing documents, facts, and large texts that 
    can be searched semantically (e.g. via vector embeddings).
    """

    @abstractmethod
    def insert(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Inserts a new document/text into the archival memory."""
        pass

    @abstractmethod
    def search(self, query: str, page: int = 1, page_size: int = 5) -> List[Dict[str, Any]]:
        """
        Searches the archival memory for semantically similar content.
        
        Args:
            query: The text to search for.
            page: The page number (1-indexed).
            page_size: The number of results per page.
            
        Returns:
            A list of dictionaries containing 'content' and 'metadata'.
        """
        pass

class BaseRecallMemory(ABC):
    """
    Abstract interface for Recall Memory (Short-term/rolling conversation history).
    
    This memory is used for storing the chronological log of interactions 
    (user messages, agent responses, system alerts).
    """

    @abstractmethod
    def append_message(self, role: str, content: str) -> None:
        """Appends a new message to the recall memory."""
        pass

    @abstractmethod
    def search_keyword(self, keyword: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Searches the recall memory for exact keyword matches.
        
        Args:
            keyword: The exact string to look for.
            limit: Maximum number of messages to return.
            
        Returns:
            A list of dictionaries containing 'timestamp', 'role', and 'content'.
        """
        pass
