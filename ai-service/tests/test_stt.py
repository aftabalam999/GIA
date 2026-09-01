import io
import wave
import math
import struct
import asyncio
import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from app.schemas.stt import STTModelState, StructuredTranscriptionResult
from app.services.stt_service import WhisperSTTService, gia_stt_service
from app.core.exceptions import (
    ModelNotReadyException,
    AudioProcessingException,
    TranscriptionException,
    TranscriptionTimeoutException
)

def create_synthetic_wav_bytes(duration_seconds: float = 1.0, sample_rate: int = 16000, frequency: float = 440.0, silent: bool = False) -> bytes:
    """Generates in-memory valid PCM WAV audio bytes for testing."""
    num_samples = int(sample_rate * duration_seconds)
    pcm_data = bytearray()
    
    for i in range(num_samples):
        if silent:
            sample_val = 0
        else:
            t = float(i) / sample_rate
            sample_val = int(16000 * math.sin(2.0 * math.pi * frequency * t))
        pcm_data.extend(struct.pack('<h', sample_val))
        
    wav_io = io.BytesIO()
    with wave.open(wav_io, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_data)
        
    return wav_io.getvalue()

@pytest.fixture
def mock_whisper_model():
    """Returns a mock faster_whisper model."""
    mock_model = MagicMock()
    
    # Mock segment object
    seg1 = MagicMock()
    seg1.start = 0.0
    seg1.end = 1.2
    seg1.text = " Hello GIA"
    seg1.avg_logprob = -0.1
    
    seg2 = MagicMock()
    seg2.start = 1.2
    seg2.end = 2.5
    seg2.text = " this is a speech test"
    seg2.avg_logprob = -0.2

    info = MagicMock()
    info.language = "en"
    info.language_probability = 0.98

    mock_model.transcribe.return_value = ([seg1, seg2], info)
    return mock_model

def test_stt_model_lifecycle_success(mock_whisper_model):
    """Test STT model initialization lifecycle: UNINITIALIZED -> LOADING -> READY."""
    async def _run():
        service = WhisperSTTService(model_name="tiny", device="cpu")
        assert service.state == STTModelState.UNINITIALIZED
        assert service.is_ready() is False

        with patch("faster_whisper.WhisperModel", return_value=mock_whisper_model):
            await service.initialize()
            assert service.state == STTModelState.READY
            assert service.is_ready() is True
            assert service.get_status().is_ready is True
            assert service.get_status().error is None

        await service.shutdown()
        assert service.state == STTModelState.UNINITIALIZED
        assert service.is_ready() is False

    asyncio.run(_run())

def test_stt_model_lifecycle_failure():
    """Test STT model initialization failure: UNINITIALIZED -> LOADING -> FAILED."""
    async def _run():
        service = WhisperSTTService(model_name="nonexistent_model_name", device="cpu")
        assert service.state == STTModelState.UNINITIALIZED

        with patch("faster_whisper.WhisperModel", side_effect=RuntimeError("Model download error")):
            await service.initialize()
            assert service.state == STTModelState.FAILED
            assert service.is_ready() is False
            status = service.get_status()
            assert status.state == STTModelState.FAILED
            assert "Model download error" in status.error

    asyncio.run(_run())

def test_transcribe_when_model_unready():
    """Test transcribing when model is UNINITIALIZED raises ModelNotReadyException."""
    async def _run():
        service = WhisperSTTService()
        audio = create_synthetic_wav_bytes(duration_seconds=0.5)

        with pytest.raises(ModelNotReadyException) as exc_info:
            await service.transcribe_structured(audio)
        assert "not ready" in str(exc_info.value)

    asyncio.run(_run())

def test_transcribe_silence(mock_whisper_model):
    """Test transcribing pure silence returns empty structured result without model execution."""
    async def _run():
        service = WhisperSTTService()
        service._model = mock_whisper_model
        service._state = STTModelState.READY

        silent_wav = create_synthetic_wav_bytes(duration_seconds=1.0, silent=True)
        res = await service.transcribe_structured(silent_wav)

        assert isinstance(res, StructuredTranscriptionResult)
        assert res.text == ""
        assert res.confidence == 0.0
        assert len(res.segments) == 0
        assert res.duration > 0.0
        assert res.processing_time >= 0.0
        # Whisper model should not be invoked for silence
        mock_whisper_model.transcribe.assert_not_called()

    asyncio.run(_run())

def test_transcribe_english_speech_short_and_long(mock_whisper_model):
    """Test structured transcription with mock English speech (short & long)."""
    async def _run():
        service = WhisperSTTService()
        service._model = mock_whisper_model
        service._state = STTModelState.READY

        audio_data = create_synthetic_wav_bytes(duration_seconds=2.5, silent=False)
        res = await service.transcribe_structured(audio_data, language="en")

        assert res.text == "Hello GIA this is a speech test"
        assert res.language == "en"
        assert res.confidence == 0.98
        assert res.duration >= 2.4
        assert len(res.segments) == 2
        assert res.segments[0].text == "Hello GIA"
        assert res.segments[0].start == 0.0
        assert res.segments[0].end == 1.2
        assert res.segments[1].text == "this is a speech test"

    asyncio.run(_run())

def test_transcribe_invalid_audio(mock_whisper_model):
    """Test submitting corrupt/invalid audio payload raises AudioProcessingException."""
    async def _run():
        service = WhisperSTTService()
        service._model = mock_whisper_model
        service._state = STTModelState.READY

        corrupt_bytes = b"CORRUPT_NOT_AN_AUDIO_FILE_DATA_HEADER_12345"
        with pytest.raises(AudioProcessingException):
            await service.transcribe_structured(corrupt_bytes)

    asyncio.run(_run())

def test_transcribe_timeout():
    """Test transcription timing out raises TranscriptionTimeoutException."""
    async def _run():
        service = WhisperSTTService(timeout_seconds=0.01)
        service._state = STTModelState.READY
        
        def slow_transcribe(*args, **kwargs):
            import time
            time.sleep(0.1)
            return ([], MagicMock(language="en", language_probability=1.0))

        mock_slow_model = MagicMock()
        mock_slow_model.transcribe = slow_transcribe
        service._model = mock_slow_model

        audio_data = create_synthetic_wav_bytes(duration_seconds=1.0, silent=False)
        with pytest.raises(TranscriptionTimeoutException):
            await service.transcribe_structured(audio_data)

    asyncio.run(_run())

def test_concurrent_transcription_requests(mock_whisper_model):
    """Test concurrent transcription requests execute safely and queue via inference lock."""
    async def _run():
        service = WhisperSTTService()
        service._model = mock_whisper_model
        service._state = STTModelState.READY

        audio_data = create_synthetic_wav_bytes(duration_seconds=1.0, silent=False)

        tasks = [
            service.transcribe_structured(audio_data)
            for _ in range(5)
        ]
        results = await asyncio.gather(*tasks)

        assert len(results) == 5
        for res in results:
            assert res.text == "Hello GIA this is a speech test"
            assert res.language == "en"

    asyncio.run(_run())

# --- API Endpoint Tests using FastAPI TestClient ---

def test_api_stt_status_endpoint(client):
    """Test GET /v1/stt/status and GET /api/v1/stt/status endpoints."""
    res1 = client.get("/v1/stt/status")
    assert res1.status_code == 200
    data1 = res1.json()
    assert "state" in data1
    assert "is_ready" in data1
    assert "model_name" in data1

    res2 = client.get("/api/v1/stt/status")
    assert res2.status_code == 200
    assert res2.json() == data1

def test_api_stt_transcribe_unready(client):
    """Test POST /v1/stt/transcribe when model is not ready returns HTTP 503."""
    audio = create_synthetic_wav_bytes(duration_seconds=0.5)
    
    with patch.object(gia_stt_service, "is_ready", return_value=False):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("audio.wav", audio, "audio/wav")}
        )
        assert response.status_code == 503
        data = response.json()
        assert "error" in data or "detail" in data

def test_api_stt_transcribe_empty_payload(client):
    """Test POST /v1/stt/transcribe with empty 0-byte file returns HTTP 400."""
    with patch.object(gia_stt_service, "is_ready", return_value=True):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("empty.wav", b"", "audio/wav")}
        )
        assert response.status_code == 400

def test_api_stt_transcribe_invalid_audio(client):
    """Test POST /v1/stt/transcribe with malformed audio returns HTTP 422."""
    with patch.object(gia_stt_service, "is_ready", return_value=True):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("bad.wav", b"INVALID_CORRUPT_BYTES", "audio/wav")}
        )
        assert response.status_code == 422

def test_api_stt_transcribe_success(client, mock_whisper_model):
    """Test POST /v1/stt/transcribe success with valid audio."""
    audio = create_synthetic_wav_bytes(duration_seconds=1.5, silent=False)
    
    with patch.object(gia_stt_service, "is_ready", return_value=True), \
         patch.object(gia_stt_service, "_model", mock_whisper_model):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("speech.wav", audio, "audio/wav")},
            data={"language": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["text"] == "Hello GIA this is a speech test"
        assert data["language"] == "en"
        assert "duration" in data
        assert "segments" in data
        assert "processing_time" in data

def test_health_reports_stt_readiness(client):
    """Test GET /health separate reporting of STT readiness status."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "subsystems" in data
    assert "stt" in data["subsystems"]
    assert isinstance(data["subsystems"]["stt"], bool)
