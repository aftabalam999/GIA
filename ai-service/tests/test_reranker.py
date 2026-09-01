import pytest
from app.services.reranker_service import GIARerankerService

@pytest.mark.anyio
async def test_reranker_service_lifecycle():
    service = GIARerankerService()
    assert service.is_ready() is False
    
    await service.initialize()
    assert service.is_ready() is True

    docs = [
        "Unrelated document about baking cakes",
        "GIA AI voice assistant documentation and setup guide",
        "Weather forecast for tomorrow afternoon"
    ]
    query = "GIA voice assistant documentation"

    results = await service.rerank(query, docs, top_k=2)
    assert len(results) == 2
    assert results[0]["document"] == "GIA AI voice assistant documentation and setup guide"
    assert results[0]["relevance_score"] > results[1]["relevance_score"]

    await service.shutdown()
    assert service.is_ready() is False

def test_api_reranker_status(client):
    response = client.get("/v1/reranker/status")
    assert response.status_code == 200
    data = response.json()
    assert data["is_ready"] is True
    assert data["model_name"] == "bge-reranker-base"

def test_api_reranker_rerank(client):
    payload = {
        "query": "PostgreSQL database configuration",
        "documents": [
            "Baking recipe for chocolate cake",
            "Configuring PostgreSQL database connection pool and pgvector extension",
            "Latest news in stock market index"
        ],
        "top_k": 2
    }
    response = client.post("/v1/reranker/rerank", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "results" in data
    assert len(data["results"]) == 2
    assert data["results"][0]["index"] == 1
    assert "PostgreSQL" in data["results"][0]["document"]
    assert data["processing_time"] >= 0

def test_api_reranker_empty_query(client):
    response = client.post("/v1/reranker/rerank", json={"query": "", "documents": ["doc1"]})
    assert response.status_code == 422
