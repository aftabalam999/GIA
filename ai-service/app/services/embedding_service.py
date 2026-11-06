import os
import asyncio
import logging
from pathlib import Path
from typing import List, Optional, Union
import torch
from sentence_transformers import SentenceTransformer

from app.services.base_embedding import EmbeddingService
from app.core.config import settings

logger = logging.getLogger("ai_service.services.embedding")

class GIAEmbeddingService(EmbeddingService):
    """
    Production-ready Local Embedding Service implementation for GIA AI.
    Loads local Sentence Transformers weights from disk once during startup lifecycle.
    Operates strictly offline with local_files_only=True.
    Hardware accelerated on Apple Silicon MPS or CUDA with automatic CPU fallback.
    Produces 384-dimensional L2-normalized float embeddings.
    """

    def __init__(
        self,
        model_name: Optional[str] = None,
        model_path: Optional[str] = None,
        dimension: Optional[int] = None,
    ):
        self.model_name = model_name or settings.EMBEDDING_MODEL_NAME
        self.model_path = model_path or settings.EMBEDDING_MODEL_PATH
        self.dimension = dimension or settings.EMBEDDING_DIMENSION
        self.device = "cpu"
        self.model: Optional[SentenceTransformer] = None
        self._is_initialized = False
        self._init_error: Optional[str] = None

    def _resolve_model_path(self) -> Path:
        """Resolves the absolute path to the local embedding model directory."""
        path = Path(self.model_path)
        if path.is_absolute() and path.exists():
            return path
        
        # Check relative to cwd
        if path.exists():
            return path.resolve()

        # Check relative to repo root (ai-service parent or current folder)
        base_dir = Path(__file__).resolve().parent.parent.parent
        candidate = base_dir / self.model_path
        if candidate.exists():
            return candidate.resolve()
        
        candidate_sub = base_dir / "models" / "embeddings" / "all-MiniLM-L6-v2"
        if candidate_sub.exists():
            return candidate_sub.resolve()

        return path.resolve()

    def _select_device(self) -> str:
        """Determines optimal inference device (mps/cuda/cpu)."""
        target_device = settings.EMBEDDING_DEVICE.lower()
        if target_device == "auto":
            if torch.backends.mps.is_available():
                return "mps"
            if torch.cuda.is_available():
                return "cuda"
            return "cpu"
        return target_device

    async def initialize(self) -> None:
        """Loads embedding model once during application startup strictly from local files."""
        resolved_path = self._resolve_model_path()
        selected_device = self._select_device()
        self.device = selected_device

        logger.info(
            f"Initializing EmbeddingService from '{resolved_path}' on device '{self.device}' "
            f"(local_files_only={settings.EMBEDDING_LOCAL_FILES_ONLY})..."
        )

        if not resolved_path.exists():
            err_msg = f"Embedding model directory does not exist: {resolved_path}"
            logger.error(err_msg)
            self._init_error = err_msg
            self._is_initialized = False
            raise FileNotFoundError(err_msg)

        def _load():
            try:
                return SentenceTransformer(
                    str(resolved_path),
                    device=self.device,
                    local_files_only=settings.EMBEDDING_LOCAL_FILES_ONLY,
                )
            except Exception as e:
                if self.device != "cpu":
                    logger.warning(
                        f"Failed to initialize embedding model on {self.device}: {e}. "
                        "Falling back to CPU..."
                    )
                    self.device = "cpu"
                    return SentenceTransformer(
                        str(resolved_path),
                        device="cpu",
                        local_files_only=settings.EMBEDDING_LOCAL_FILES_ONLY,
                    )
                raise

        try:
            self.model = await asyncio.to_thread(_load)
            self._is_initialized = True
            self._init_error = None
            logger.info(
                f"EmbeddingService '{self.model_name}' successfully loaded on {self.device} "
                f"(dimension={self.dimension})."
            )
        except Exception as e:
            self._is_initialized = False
            self._init_error = str(e)
            logger.error(f"Failed to initialize EmbeddingService: {e}")
            raise

    async def shutdown(self) -> None:
        """Releases embedding model resources and frees memory."""
        logger.info("Shutting down EmbeddingService...")
        self.model = None
        self._is_initialized = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif torch.backends.mps.is_available():
            try:
                torch.mps.empty_cache()
            except Exception:
                pass

    def is_ready(self) -> bool:
        return self._is_initialized and self.model is not None

    def _encode_sync(self, texts: Union[str, List[str]]) -> Union[List[float], List[List[float]]]:
        """Synchronously encodes text string or list of text strings into normalized float vectors."""
        if self.model is None:
            raise RuntimeError("Embedding model is not loaded")
        
        # SentenceTransformer.encode returns numpy ndarray when normalize_embeddings=True
        embs = self.model.encode(texts, normalize_embeddings=True)
        if isinstance(texts, str):
            return embs.tolist()
        return [e.tolist() for e in embs]

    async def embed_text(self, text: str) -> List[float]:
        """Generates a 384-dimensional normalized float embedding for a single text."""
        if not self.is_ready():
            raise RuntimeError("EmbeddingService is not initialized or ready")
        if not text or not text.strip():
            raise ValueError("Text content cannot be empty")
        return await asyncio.to_thread(self._encode_sync, text)

    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generates 384-dimensional normalized float embeddings for a batch of texts."""
        if not self.is_ready():
            raise RuntimeError("EmbeddingService is not initialized or ready")
        if not texts:
            return []
        # Filter empty strings or preserve positions
        return await asyncio.to_thread(self._encode_sync, texts)

gia_embedding_service = GIAEmbeddingService()
