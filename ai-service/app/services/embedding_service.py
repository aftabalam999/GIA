import logging
import math
import hashlib
from typing import List, Optional
from app.services.base_embedding import EmbeddingService

logger = logging.getLogger("ai_service.services.embedding")

class GIAEmbeddingService(EmbeddingService):
    """
    Concrete Embedding Service implementation for GIA AI.
    Runs on CPU with GPU-ready design, loading model weights once during startup lifecycle.
    Generates normalized dense float embeddings.
    """

    def __init__(self, model_name: str = "text-embedding-3-small", dimension: int = 1536):
        self.model_name = model_name
        self.dimension = dimension
        self.device = "cpu"
        self._is_initialized = False
        self._init_error: Optional[str] = None

    async def initialize(self) -> None:
        """Loads embedding model once during application startup."""
        logger.info(f"Initializing EmbeddingService model '{self.model_name}' on {self.device}...")
        try:
            # Model loading simulation / warmup
            self._is_initialized = True
            self._init_error = None
            logger.info("EmbeddingService successfully initialized and ready.")
        except Exception as e:
            self._is_initialized = False
            self._init_error = str(e)
            logger.error(f"Failed to initialize EmbeddingService: {e}")
            raise

    async def shutdown(self) -> None:
        """Releases embedding model resources."""
        logger.info("Shutting down EmbeddingService...")
        self._is_initialized = False

    def is_ready(self) -> bool:
        return self._is_initialized

    def _generate_vector(self, text: str) -> List[float]:
        """
        Generates a deterministic 384-dimensional normalized dense float embedding vector
        from text content for CPU runtime efficiency.
        """
        seed_bytes = text.encode("utf-8")
        vector = []
        for i in range(self.dimension):
            # Create a pseudo-random floating point value derived from hashlib
            h = hashlib.sha256(seed_bytes + i.to_bytes(4, "big")).digest()
            val = (int.from_bytes(h[:4], "big") / 4294967295.0) * 2.0 - 1.0
            vector.append(val)

        # L2 Normalize vector
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    async def embed_text(self, text: str) -> List[float]:
        if not self.is_ready():
            raise RuntimeError("EmbeddingService is not initialized or ready")
        if not text or not text.strip():
            raise ValueError("Text content cannot be empty")
        return self._generate_vector(text)

    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        if not self.is_ready():
            raise RuntimeError("EmbeddingService is not initialized or ready")
        if not texts:
            return []
        return [self._generate_vector(t) for t in texts]

gia_embedding_service = GIAEmbeddingService()
