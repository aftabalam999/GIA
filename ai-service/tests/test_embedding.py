import pytest
from app.services.embedding_service import GIAEmbeddingService

@pytest.mark.anyio
async def test_embedding_service_lifecycle():
    service = GIAEmbeddingService(dimension=1536)
    assert service.is_ready() is False
    
    await service.initialize()
    assert service.is_ready() is True

    vector = await service.embed_text("Hello GIA RAG vector search")
    assert isinstance(vector, list)
    assert len(vector) == 1536
    assert isinstance(vector[0], float)

    batch_vectors = await service.embed_batch(["Text one", "Text two"])
    assert len(batch_vectors) == 2
    assert len(batch_vectors[0]) == 1536
    assert len(batch_vectors[1]) == 1536

    await service.shutdown()
    assert service.is_ready() is False

def test_api_embeddings_status(client):
    response = client.get("/v1/embeddings/status")
    assert response.status_code == 200
    data = response.json()
    assert data["is_ready"] is True
    assert data["dimension"] == 1536
    assert data["model_name"] == "text-embedding-3-small"

def test_api_embeddings_embed_single(client):
    response = client.post("/v1/embeddings/embed", json={"text": "PostgreSQL pgvector chunk"})
    assert response.status_code == 200
    data = response.json()
    assert data["embedding"] is not None
    assert len(data["embedding"]) == 1536
    assert data["dimension"] == 1536
    assert data["processing_time"] >= 0

def test_api_embeddings_embed_batch(client):
    response = client.post("/v1/embeddings/embed", json={"texts": ["Doc chunk A", "Doc chunk B"]})
    assert response.status_code == 200
    data = response.json()
    assert data["embeddings"] is not None
    assert len(data["embeddings"]) == 2
    assert len(data["embeddings"][0]) == 1536

def test_api_embeddings_embed_empty_payload(client):
    response = client.post("/v1/embeddings/embed", json={})
    assert response.status_code == 422
