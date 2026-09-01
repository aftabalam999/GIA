from pydantic import BaseModel, Field
from typing import List, Optional

class RerankRequest(BaseModel):
    query: str = Field(..., description="Query string to score candidates against")
    documents: List[str] = Field(..., description="List of candidate document texts to rerank")
    top_k: Optional[int] = Field(None, description="Maximum number of top results to return")

class RerankResultItem(BaseModel):
    index: int = Field(..., description="Original zero-based index in candidate input array")
    document: str = Field(..., description="Candidate document text content")
    relevance_score: float = Field(..., description="Semantic relevance score (0.0 to 1.0)")

class RerankResponse(BaseModel):
    results: List[RerankResultItem] = Field(..., description="Reranked candidate documents sorted by relevance score descending")
    processing_time: float = Field(..., description="Processing time in seconds")

class RerankerStatusResponse(BaseModel):
    is_ready: bool = Field(..., description="Model readiness boolean")
    model_name: str = Field(..., description="Reranker model identifier")
    device: str = Field(..., description="Model execution device (cpu/cuda)")
