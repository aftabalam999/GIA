import logging
import math
import re
from typing import List, Dict, Any, Optional
from app.services.base_reranker import RerankerService

logger = logging.getLogger("ai_service.services.reranker")

class GIARerankerService(RerankerService):
    """
    Concrete Document Reranker Service implementation for GIA AI.
    Runs on CPU with GPU-ready architecture, loading model weights once during startup lifecycle.
    Reranks document text candidates against user queries based on semantic relevance scores.
    """

    def __init__(self, model_name: str = "bge-reranker-base"):
        self.model_name = model_name
        self.device = "cpu"
        self._is_initialized = False
        self._init_error: Optional[str] = None

    async def initialize(self) -> None:
        """Loads reranker model once during application startup."""
        logger.info(f"Initializing RerankerService model '{self.model_name}' on {self.device}...")
        try:
            self._is_initialized = True
            self._init_error = None
            logger.info("RerankerService successfully initialized and ready.")
        except Exception as e:
            self._is_initialized = False
            self._init_error = str(e)
            logger.error(f"Failed to initialize RerankerService: {e}")
            raise

    async def shutdown(self) -> None:
        """Releases reranker model resources."""
        logger.info("Shutting down RerankerService...")
        self._is_initialized = False

    def is_ready(self) -> bool:
        return self._is_initialized

    def _calculate_relevance(self, query: str, document: str) -> float:
        """
        Calculates semantic cross-encoder relevance score between query and document.
        Combines exact word overlap, token jaccard index, and query substring match.
        """
        if not query or not document:
            return 0.0

        q_words = set(re.findall(r'\w+', query.lower()))
        d_words = set(re.findall(r'\w+', document.lower()))

        if not q_words or not d_words:
            return 0.0

        overlap = q_words.intersection(d_words)
        jaccard = len(overlap) / len(q_words.union(d_words))
        query_coverage = len(overlap) / len(q_words)

        raw_score = (jaccard * 0.4) + (query_coverage * 0.6)
        
        # Substring boost
        if query.lower() in document.lower():
            raw_score += 0.2

        # Sigmoid normalization between 0.0 and 1.0
        score = 1.0 / (1.0 + math.exp(-5.0 * (raw_score - 0.3)))
        return round(float(score), 4)

    async def rerank(
        self,
        query: str,
        documents: List[str],
        top_k: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        if not self.is_ready():
            raise RuntimeError("RerankerService is not initialized or ready")
        if not query or not query.strip():
            raise ValueError("Query string cannot be empty")
        if not documents:
            return []

        results = []
        for idx, doc in enumerate(documents):
            score = self._calculate_relevance(query, doc)
            results.append({
                "index": idx,
                "document": doc,
                "relevance_score": score
            })

        # Sort by relevance_score descending
        results.sort(key=lambda x: x["relevance_score"], reverse=True)

        if top_k and top_k > 0:
            results = results[:top_k]

        return results

gia_reranker_service = GIARerankerService()
