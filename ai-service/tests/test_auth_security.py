import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import settings

def test_unauthenticated_call_rejected():
    # Call without valid internal API key header
    unauth_client = TestClient(app, headers={"x-internal-api-key": "invalid_key_123"})
    response = unauth_client.get("/v1/stt/status")
    assert response.status_code == 401
    assert "detail" in response.json() or "error" in response.json()

def test_authenticated_call_accepted(client):
    # Call with valid internal API key header via conftest fixture
    response = client.get("/v1/stt/status")
    assert response.status_code == 200
    assert response.json()["is_ready"] is True
