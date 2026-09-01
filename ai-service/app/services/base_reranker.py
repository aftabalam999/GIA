from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class RerankerService(ABC):
    """
    Abstract interface for Document Reranker engines.
    Allows different cross-encoders or semantic ranking models (bge-reranker, ms-marco, etc.)
    to be substituted without changing service/route boundaries.
    """

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize and warm up the reranker model weights."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Tear down and release reranker model resources."""
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """Returns True if the reranker engine is loaded and ready."""
        pass

    @abstractmethod
    async def rerank(
        self,
        query: str,
        documents: List[str],
        top_k: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Reranks candidate document texts against a target query string.

        Returns:
            List of dicts: [{"index": int, "document": str, "relevance_score": float}]
            sorted by relevance_score descending.
        """
        pass
