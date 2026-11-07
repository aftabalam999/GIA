import io
import os
import wave
import time
import math
import asyncio
import pytest
import numpy as np
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.schemas.stt import STTModelState, StructuredTranscriptionResult, TranscriptionSegment
from app.services.stt_service import WhisperSTTService, gia_stt_service
from app.services.whisper_ggml import WhisperGGMLEngine, WHISPER_SAMPLE_RATE
from app.services.vad_service import GIAVoiceActivityDetector
from app.schemas.vad import VADConfig, VADEventType
from app.services.audio_processor import NormalizedAudio, gia_audio_processor
from app.core.exceptions import (
    ModelNotReadyException,
    AudioProcessingException,
    TranscriptionException,
    TranscriptionTimeoutException
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"

def load_fixture_bytes(name: str) -> bytes:
    """Loads a real WAV audio fixture from tests/fixtures."""
    path = FIXTURES_DIR / name
    if not path.is_file():
        pytest.skip(f"Audio fixture '{name}' not found at {path}")
    with open(path, "rb") as f:
        return f.read()

# ---------------------------------------------------------------------------
# 1. Model Path Resolution
# ---------------------------------------------------------------------------
def test_stt_model_path_resolution():
    engine = WhisperGGMLEngine()
    resolved = engine._resolve_model_path()
    assert resolved is not None
    assert resolved.is_file()
    assert "ggml-small-q5_1.bin" in resolved.name

    # Test non-existent path
    engine_bad = WhisperGGMLEngine(model_path="nonexistent_path/fake_model.bin")
    resolved_bad = engine_bad._resolve_model_path()
    # It searches fallbacks or returns None
    if resolved_bad:
        assert resolved_bad.is_file()

# ---------------------------------------------------------------------------
# 2. Model Loading & Lifecycle
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_stt_model_loading_and_lifecycle():
    service = WhisperSTTService()
    assert service.state == STTModelState.UNINITIALIZED
    assert service.is_ready() is False

    await service.initialize()
    assert service.state == STTModelState.READY
    assert service.is_ready() is True
    status = service.get_status()
    assert status.is_ready is True
    assert status.error is None
    assert status.model_name == "small"

    # Idempotent initialization
    await service.initialize()
    assert service.is_ready() is True

    await service.shutdown()
    assert service.state == STTModelState.UNINITIALIZED
    assert service.is_ready() is False

# ---------------------------------------------------------------------------
# 3. Real English Speech Transcription
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_english_transcription():
    wav_bytes = load_fixture_bytes("speech_en.wav")
    service = WhisperSTTService()
    await service.initialize()

    res = await service.transcribe_structured(wav_bytes, language="en")
    assert isinstance(res, StructuredTranscriptionResult)
    assert "Open the browser and search YouTube" in res.text
    assert res.language == "en"
    assert res.confidence > 0.5
    assert res.duration > 0.0
    assert len(res.segments) >= 1
    assert res.segments[0].end > res.segments[0].start

    await service.shutdown()

# ---------------------------------------------------------------------------
# 4. Real Hindi Speech Transcription
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_hindi_transcription():
    wav_bytes = load_fixture_bytes("speech_hi.wav")
    service = WhisperSTTService()
    await service.initialize()

    res = await service.transcribe_structured(wav_bytes, language="hi")
    assert isinstance(res, StructuredTranscriptionResult)
    # Checks Devanagari script presence
    assert "नमस्ते" in res.text or "कैसे" in res.text
    assert res.language == "hi"
    assert res.confidence > 0.5
    assert len(res.segments) >= 1

    await service.shutdown()

# ---------------------------------------------------------------------------
# 5. Automatic Language Detection
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_automatic_language_detection():
    service = WhisperSTTService()
    await service.initialize()

    # 1. English audio with auto detection
    wav_en = load_fixture_bytes("speech_en.wav")
    res_en = await service.transcribe_structured(wav_en, language="auto")
    assert res_en.language == "en"
    assert "Open the browser and search YouTube" in res_en.text

    # 2. Hindi audio with auto detection
    wav_hi = load_fixture_bytes("speech_hi.wav")
    res_hi = await service.transcribe_structured(wav_hi, language="auto")
    assert res_hi.language == "hi"
    assert "नमस्ते" in res_hi.text or "कैसे" in res_hi.text

    await service.shutdown()

# ---------------------------------------------------------------------------
# 6. Mixed Hindi-English Transcription
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_mixed_hindi_english_transcription():
    wav_mixed = load_fixture_bytes("speech_mixed.wav")
    service = WhisperSTTService()
    await service.initialize()

    res = await service.transcribe_structured(wav_mixed, language="auto")
    assert isinstance(res, StructuredTranscriptionResult)
    # Verifies both concepts/words are recognized
    assert len(res.text.strip()) > 0
    assert any(term in res.text.lower() for term in ["namaste", "weather", "gia", "नमस्ते"])

    await service.shutdown()

# ---------------------------------------------------------------------------
# 7. Empty & Silent Audio Handling
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_empty_and_silent_audio():
    service = WhisperSTTService()
    await service.initialize()

    # Empty 0-byte payload raises AudioProcessingException
    with pytest.raises(AudioProcessingException):
        await service.transcribe_structured(b"")

    # Pure silence returns blank transcription immediately
    with wave.open(io.BytesIO(), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 32000)  # 1 sec silence
        silent_wav = w._file.getvalue()

    res_silent = await service.transcribe_structured(silent_wav)
    assert res_silent.text == ""
    assert res_silent.confidence == 0.0

    await service.shutdown()

# ---------------------------------------------------------------------------
# 8. Invalid Audio Payload Handling
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_invalid_audio_payload():
    service = WhisperSTTService()
    await service.initialize()

    corrupt_bytes = b"CORRUPTED_NOT_A_VALID_AUDIO_CONTAINER_OR_PCM_STREAM"
    with pytest.raises(AudioProcessingException):
        await service.transcribe_structured(corrupt_bytes)

    await service.shutdown()

# ---------------------------------------------------------------------------
# 9. Incorrect Sample Rate Handling
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_incorrect_sample_rate_handling():
    service = WhisperSTTService()
    await service.initialize()

    # Create NormalizedAudio with incorrect sample rate (e.g. 44100 Hz instead of 16000 Hz)
    bad_utterance = NormalizedAudio(
        pcm_bytes=b"\x00" * 1600,
        samples_float32=np.zeros(800, dtype=np.float32),
        sample_rate=44100,
        channels=1,
        duration_seconds=0.5
    )

    with pytest.raises(AudioProcessingException) as exc_info:
        await service.transcribe_utterance(bad_utterance)
    assert "16000" in str(exc_info.value)

    await service.shutdown()

# ---------------------------------------------------------------------------
# 10. Repeated Transcription Without Model Reload
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_repeated_transcription_without_reload():
    service = WhisperSTTService()
    await service.initialize()

    model_ref = service._engine._model
    assert model_ref is not None

    wav_bytes = load_fixture_bytes("speech_en.wav")

    # Run 3 consecutive transcriptions
    for i in range(3):
        res = await service.transcribe_structured(wav_bytes, language="en")
        assert "Open the browser" in res.text
        # Model instance reference must remain identical (no reload)
        assert service._engine._model is model_ref

    await service.shutdown()

# ---------------------------------------------------------------------------
# 11. Full Silero VAD to Whisper STT Integration Pipeline
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_vad_to_stt_integration():
    """
    Simulates the full microphone streaming loop:
    Audio Chunks -> Silero VAD -> Utterance Completed -> Whisper STT (zero file I/O).
    """
    wav_bytes = load_fixture_bytes("speech_en.wav")
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        frames = w.readframes(w.getnframes())
        audio_i16 = np.frombuffer(frames, dtype=np.int16)

    # 1. Setup VAD
    vad_config = VADConfig(
        use_silero=True,
        speech_threshold=0.3,
        min_speech_duration_ms=100.0,
        end_of_speech_timeout_ms=200.0
    )
    vad = GIAVoiceActivityDetector(config=vad_config)

    # 2. Setup STT
    stt = WhisperSTTService()
    await stt.initialize()

    # 3. Stream audio in 100ms frames to VAD
    chunk_samples = 1600
    completed_utterance: Optional[NormalizedAudio] = None

    for i in range(0, len(audio_i16), chunk_samples):
        chunk = audio_i16[i : i + chunk_samples]
        res = vad.process_chunk(chunk.tobytes())
        if res.utterance_completed:
            completed_utterance = vad.pop_utterance_audio()
            break

    # Feed trailing silence if needed to trigger VOICE_ENDED
    if not completed_utterance:
        silence_chunk = np.zeros(1600, dtype=np.int16).tobytes()
        for _ in range(5):
            res_sil = vad.process_chunk(silence_chunk)
            if res_sil.utterance_completed:
                completed_utterance = vad.pop_utterance_audio()
                break

    assert completed_utterance is not None
    assert isinstance(completed_utterance, NormalizedAudio)
    assert completed_utterance.sample_rate == 16000

    # 4. Ingest utterance directly into STT without disk I/O
    transcription_result = await stt.transcribe_utterance(completed_utterance, language="en")
    assert isinstance(transcription_result, StructuredTranscriptionResult)
    assert "Open the browser" in transcription_result.text
    assert transcription_result.duration > 0.0

    await stt.shutdown()

# ---------------------------------------------------------------------------
# 12. Offline Operation Verification
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_offline_operation():
    """Verifies that the entire STT transcription pipeline operates completely offline."""
    import socket
    service = WhisperSTTService()
    await service.initialize()

    wav_bytes = load_fixture_bytes("speech_en.wav")

    # Block socket connections to simulate strict offline airgap
    orig_connect = socket.socket.connect
    def mock_connect(*args, **kwargs):
        raise RuntimeError("Network disabled: Airgap violation detected!")

    with patch.object(socket.socket, "connect", side_effect=mock_connect):
        res = await service.transcribe_structured(wav_bytes, language="en")
        assert "Open the browser" in res.text

    await service.shutdown()

# ---------------------------------------------------------------------------
# 13. Transcription Timeout Handling
# ---------------------------------------------------------------------------
@pytest.mark.anyio
async def test_transcription_timeout():
    service = WhisperSTTService(timeout_seconds=0.01)
    service._state = STTModelState.READY

    def slow_transcribe(*args, **kwargs):
        time.sleep(0.1)
        return "slow", "en", 1.0, []

    with patch.object(service._engine, "is_ready", return_value=True), \
         patch.object(service._engine, "transcribe_samples", side_effect=slow_transcribe):
        wav_bytes = load_fixture_bytes("speech_en.wav")
        with pytest.raises(TranscriptionTimeoutException):
            await service.transcribe_structured(wav_bytes)

# ---------------------------------------------------------------------------
# 14. API Endpoints
# ---------------------------------------------------------------------------
def test_api_stt_status_endpoint(client):
    res = client.get("/v1/stt/status")
    assert res.status_code == 200
    data = res.json()
    assert "state" in data
    assert "is_ready" in data
    assert "model_name" in data

def test_api_stt_transcribe_unready(client):
    wav_bytes = load_fixture_bytes("speech_en.wav")
    with patch.object(gia_stt_service, "is_ready", return_value=False):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("speech.wav", wav_bytes, "audio/wav")}
        )
        assert response.status_code == 503

def test_api_stt_transcribe_empty_payload(client):
    with patch.object(gia_stt_service, "is_ready", return_value=True):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("empty.wav", b"", "audio/wav")}
        )
        assert response.status_code == 400

def test_api_stt_transcribe_invalid_audio(client):
    with patch.object(gia_stt_service, "is_ready", return_value=True):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("bad.wav", b"INVALID_BYTES_NOT_AUDIO", "audio/wav")}
        )
        assert response.status_code == 422

def test_api_stt_transcribe_success(client):
    wav_bytes = load_fixture_bytes("speech_en.wav")
    mock_seg = TranscriptionSegment(start=0.0, end=2.0, text="Open the browser and search YouTube.", confidence=0.98)
    mock_res = StructuredTranscriptionResult(
        text="Open the browser and search YouTube.",
        language="en",
        confidence=0.98,
        duration=2.15,
        segments=[mock_seg],
        processing_time=0.45
    )

    with patch.object(gia_stt_service, "is_ready", return_value=True), \
         patch.object(gia_stt_service, "transcribe_structured", return_value=mock_res):
        response = client.post(
            "/v1/stt/transcribe",
            files={"file": ("speech.wav", wav_bytes, "audio/wav")},
            data={"language": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["text"] == "Open the browser and search YouTube."
        assert data["language"] == "en"
        assert "duration" in data
        assert "segments" in data
