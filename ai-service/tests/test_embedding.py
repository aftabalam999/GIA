import math
import pytest
from app.services.embedding_service import GIAEmbeddingService
from app.core.config import settings

def cosine_similarity(v1, v2):
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    return dot / (norm1 * norm2)

@pytest.mark.anyio
async def test_embedding_service_lifecycle_and_semantic_retrieval():
    service = GIAEmbeddingService()
    assert service.is_ready() is False

    await service.initialize()
    assert service.is_ready() is True
    assert service.dimension == 384
    assert service.model_name == "all-MiniLM-L6-v2"

    # Single text embedding
    vector = await service.embed_text("GIA desktop voice assistant RAG knowledge retrieval")
    assert isinstance(vector, list)
    assert len(vector) == 384
    assert isinstance(vector[0], float)

    # L2 Norm check (SentenceTransformer with normalize_embeddings=True gives norm ≈ 1.0)
    l2_norm = math.sqrt(sum(v * v for v in vector))
    assert abs(l2_norm - 1.0) < 1e-3

    # Batch embedding
    batch_vectors = await service.embed_batch([
        "Python FastAPI backend microservice",
        "TypeScript Node.js client gateway"
    ])
    assert len(batch_vectors) == 2
    assert len(batch_vectors[0]) == 384
    assert len(batch_vectors[1]) == 384

    # Semantic similarity test: related vs unrelated
    v_ai = await service.embed_text("Artificial intelligence and neural network models")
    v_deep_learning = await service.embed_text("Deep learning architectures and transformer training")
    v_baking = await service.embed_text("Recipe for homemade chocolate chip cookies with butter and sugar")

    sim_related = cosine_similarity(v_ai, v_deep_learning)
    sim_unrelated = cosine_similarity(v_ai, v_baking)
    assert sim_related > sim_unrelated
    assert sim_related > 0.4

    # Error handling
    with pytest.raises(ValueError):
        await service.embed_text("")
    with pytest.raises(ValueError):
        await service.embed_text("   ")

    # Shutdown
    await service.shutdown()
    assert service.is_ready() is False

    with pytest.raises(RuntimeError):
        await service.embed_text("Hello")

def test_embedding_offline_enforcement():
    """Verify embedding service is configured strictly for offline local files only."""
    assert settings.EMBEDDING_LOCAL_FILES_ONLY is True
    assert settings.EMBEDDING_DIMENSION == 384

def test_api_embeddings_status(client):
    response = client.get("/v1/embeddings/status")
    assert response.status_code == 200
    data = response.json()
    assert data["is_ready"] is True
    assert data["dimension"] == 384
    assert data["model_name"] == "all-MiniLM-L6-v2"

def test_api_embeddings_embed_single(client):
    response = client.post("/v1/embeddings/embed", json={"text": "PostgreSQL pgvector chunk"})
    assert response.status_code == 200
    data = response.json()
    assert data["embedding"] is not None
    assert len(data["embedding"]) == 384
    assert data["dimension"] == 384
    assert data["processing_time"] >= 0

def test_api_embeddings_embed_batch(client):
    response = client.post("/v1/embeddings/embed", json={"texts": ["Doc chunk A", "Doc chunk B"]})
    assert response.status_code == 200
    data = response.json()
    assert data["embeddings"] is not None
    assert len(data["embeddings"]) == 2
    assert len(data["embeddings"][0]) == 384
    assert len(data["embeddings"][1]) == 384
    assert data["dimension"] == 384

def test_api_embeddings_embed_empty_payload(client):
    response = client.post("/v1/embeddings/embed", json={})
    assert response.status_code == 422
