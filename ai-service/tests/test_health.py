from app.models.lifecycle import model_lifecycle

def test_root_endpoint(client):
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "GIA AI Service"
    assert data["version"] == "1.0.0"
    assert data["status"] == "running"

def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["ready"] is True
    assert data["version"] == "1.0.0"
    assert "timestamp" in data
    
    subsystems = data["subsystems"]
    assert "audio_processor" in subsystems
    assert "vad" in subsystems
    assert "stt" in subsystems
    assert "tts" in subsystems
    assert "embedding" in subsystems
    assert "reranker" in subsystems
    assert subsystems["stt"] is True
    assert subsystems["tts"] is True

def test_readiness_endpoint(client):
    response = client.get("/v1/health/readiness")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["ready"] is True

def test_readiness_reporting_unready_subsystem(client):
    # Temporarily set STT service to unready
    original_stt = model_lifecycle._stt_service
    model_lifecycle._stt_service = None

    try:
        response = client.get("/v1/health/readiness")
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "healthy" # Process is healthy (UP)
        assert data["ready"] is False     # But overall readiness is False!
        assert data["subsystems"]["stt"] is False
    finally:
        model_lifecycle._stt_service = original_stt

def test_info_endpoint(client):
    response = client.get("/info")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "GIA AI Service"
    assert data["version"] == "1.0.0"
    assert data["environment"] == "development"
