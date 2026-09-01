import asyncio
import pytest
from app.schemas.tts import TTSModelState
from app.services.tts_service import GIATextToSpeechService
from app.core.exceptions import (
    AIServiceException,
    ModelNotReadyException,
    SynthesisTimeoutException,
)

def test_tts_service_lifecycle_and_synthesis():
    """Test TTS service initialization, single model loading, and synthesis."""
    async def _run():
        service = GIATextToSpeechService()
        assert service.state == TTSModelState.UNINITIALIZED
        assert service.is_ready() is False

        await service.initialize()
        assert service.state == TTSModelState.READY
        assert service.is_ready() is True

        audio_bytes = await service.synthesize("Hello GIA assistant test text")
        assert isinstance(audio_bytes, bytes)
        assert len(audio_bytes) > 44
        assert audio_bytes.startswith(b"RIFF")

        await service.shutdown()
        assert service.state == TTSModelState.UNINITIALIZED
        assert service.is_ready() is False

    asyncio.run(_run())

def test_tts_input_validation():
    """Test rejection of empty, null, or oversized text payloads."""
    async def _run():
        service = GIATextToSpeechService()
        await service.initialize()

        # Empty text
        with pytest.raises(AIServiceException) as exc_info:
            await service.synthesize("")
        assert exc_info.value.status_code == 400

        # Blank whitespace text
        with pytest.raises(AIServiceException) as exc_info:
            await service.synthesize("   ")
        assert exc_info.value.status_code == 400

        # Oversized text
        oversized = "A" * 2005
        with pytest.raises(AIServiceException) as exc_info:
            await service.synthesize(oversized)
        assert exc_info.value.status_code == 400

        await service.shutdown()

    asyncio.run(_run())

def test_tts_unready_model_handling():
    """Test that synthesis on unready model raises ModelNotReadyException (503)."""
    async def _run():
        service = GIATextToSpeechService()
        with pytest.raises(ModelNotReadyException) as exc_info:
            await service.synthesize("Test speech synthesis")
        assert exc_info.value.status_code == 503

    asyncio.run(_run())

def test_tts_timeout_handling():
    """Test that synthesis timeout raises SynthesisTimeoutException (504)."""
    async def _run():
        service = GIATextToSpeechService()
        service.timeout_seconds = 0.001 # Set tiny timeout
        await service.initialize()

        with pytest.raises(SynthesisTimeoutException) as exc_info:
            await service.synthesize("Test speech timeout execution")
        assert exc_info.value.status_code == 504

        await service.shutdown()

    asyncio.run(_run())

def test_api_tts_synthesize_endpoint(client):
    """Test POST /v1/tts/synthesize endpoint returning WAV audio stream."""
    response = client.post(
        "/v1/tts/synthesize",
        json={"text": "Synthesize this speech test."}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert len(response.content) > 44

def test_api_tts_synthesize_streaming(client):
    """Test POST /v1/tts/synthesize?stream=true returning chunked streaming audio."""
    response = client.post(
        "/v1/tts/synthesize?stream=true",
        json={"text": "Chunked audio stream synthesis test."}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert len(response.content) > 44

def test_api_tts_status_endpoint(client):
    """Test GET /v1/tts/status endpoint returning model status details."""
    response = client.get("/v1/tts/status")
    assert response.status_code == 200
    data = response.json()
    assert data["state"] == "READY"
    assert data["is_ready"] is True
    assert "model_name" in data
    assert "device" in data

def test_health_reports_tts_readiness(client):
    """Test GET /health reporting TTS subsystem readiness separately."""
    response = client.get("/health")
    assert response.status_code == 200
    subsystems = response.json().get("subsystems", {})
    assert "tts" in subsystems
    assert subsystems["tts"] is True
