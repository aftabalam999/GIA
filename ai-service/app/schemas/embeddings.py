from pydantic import BaseModel, Field
from typing import List, Optional

class EmbedRequest(BaseModel):
    text: Optional[str] = Field(None, description="Single text string to embed")
    texts: Optional[List[str]] = Field(None, description="Batch list of text strings to embed")

class EmbedResponse(BaseModel):
    embedding: Optional[List[float]] = Field(None, description="Vector embedding for single text input")
    embeddings: Optional[List[List[float]]] = Field(None, description="Batch vector embeddings")
    dimension: int = Field(..., description="Vector embedding dimension (e.g. 384)")
    processing_time: float = Field(..., description="Processing time in seconds")

class EmbeddingStatusResponse(BaseModel):
    is_ready: bool = Field(..., description="Model readiness boolean")
    model_name: str = Field(..., description="Embedding model identifier")
    dimension: int = Field(..., description="Vector embedding dimension")
    device: str = Field(..., description="Model execution device (cpu/cuda)")
