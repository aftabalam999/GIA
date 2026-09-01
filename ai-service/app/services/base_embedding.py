from abc import ABC, abstractmethod
from typing import List, Optional

class EmbeddingService(ABC):
    """
    Abstract interface for Text Embedding engines.
    Allows different underlying ML vectorizers (SentenceTransformers, BGE, OpenAI, MiniLM, etc.)
    to be substituted without changing service/route boundaries.
    """

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize and warm up the embedding model weights."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Tear down and release embedding model resources."""
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """Returns True if the embedding engine is loaded and ready to serve requests."""
        pass

    @abstractmethod
    async def embed_text(self, text: str) -> List[float]:
        """
        Embeds a single string into a float vector embedding.

        Returns:
            List[float] representing text vector embedding.
        """
        pass

    @abstractmethod
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Embeds a batch of strings into float vector embeddings.

        Returns:
            List[List[float]] representing vector embeddings for each input text.
        """
        pass
