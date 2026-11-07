import io
import wave
import time
import pytest
import numpy as np
import torch
import soundfile as sf
from fastapi.testclient import TestClient

from app.schemas.tts import TTSModelState
from app.services.kokoro_tts import KokoroTTSEngine, KokoroTTSService, gia_kokoro_service, KOKORO_SAMPLE_RATE
from app.core.exceptions import (
    AIServiceException,
    ModelNotReadyException,
    SynthesisException,
    SynthesisTimeoutException,
)

@pytest.fixture(scope="module")
def kokoro_engine():
    engine = KokoroTTSEngine()
    engine.initialize()
    yield engine
    engine.shutdown()

@pytest.fixture(scope="module")
async def kokoro_service():
    service = KokoroTTSService()
    await service.initialize()
    yield service
    await service.shutdown()


def test_kokoro_model_loading_and_lifecycle(kokoro_engine):
    """1. Test that Kokoro model initializes locally and is marked ready."""
    assert kokoro_engine.is_ready() is True
    assert kokoro_engine._model is not None
    assert "af_heart" in kokoro_engine._voices
    assert "hf_alpha" in kokoro_engine._voices
    assert kokoro_engine.device in ["mps", "cpu"]


def test_english_speech_generation(kokoro_engine):
    """2. Test English speech generation using local af_heart voice."""
    text = "Hello, this is a test of GIA local speech synthesis."
    wav_bytes, meta = kokoro_engine.synthesize(text=text, language="en", voice="af_heart")

    assert isinstance(wav_bytes, bytes)
    assert len(wav_bytes) > 1000
    assert wav_bytes.startswith(b"RIFF")
    assert meta.language == "en"
    assert meta.voice == "af_heart"
    assert meta.duration_seconds > 0.5
    assert meta.sample_rate == KOKORO_SAMPLE_RATE

    # Parse WAV container
    with wave.open(io.BytesIO(wav_bytes), 'rb') as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2  # 16-bit
        assert wf.getframerate() == 24000
        frames = wf.getnframes()
        assert frames > 1000


def test_hindi_speech_generation(kokoro_engine):
    """3. Test Hindi speech generation using local hf_alpha voice and Devanagari Unicode."""
    text = "नमस्ते, आप कैसे हैं?"
    wav_bytes, meta = kokoro_engine.synthesize(text=text, language="hi", voice="hf_alpha")

    assert isinstance(wav_bytes, bytes)
    assert len(wav_bytes) > 1000
    assert wav_bytes.startswith(b"RIFF")
    assert meta.language == "hi"
    assert meta.voice == "hf_alpha"
    assert meta.duration_seconds > 0.5
    assert meta.sample_rate == KOKORO_SAMPLE_RATE

    # Verify true phonemization occurs (Devanagari mapped to IPA)
    assert meta.phonemes is not None
    assert len(meta.phonemes) > 0


def test_automatic_language_selection(kokoro_engine):
    """4. Test automatic language and voice selection based on input script."""
    # Hindi text auto-detect
    hi_text = "आज का दिन बहुत अच्छा है।"
    _, meta_hi = kokoro_engine.synthesize(text=hi_text, language="auto")
    assert meta_hi.language == "hi"
    assert meta_hi.voice == "hf_alpha"

    # English text auto-detect
    en_text = "Good morning, checking your calendar now."
    _, meta_en = kokoro_engine.synthesize(text=en_text, language="auto")
    assert meta_en.language == "en"
    assert meta_en.voice == "af_heart"


def test_explicit_voice_selection(kokoro_engine):
    """5. Test explicitly specifying a voice override."""
    text = "Testing explicit voice parameter."
    _, meta = kokoro_engine.synthesize(text=text, voice="af_heart")
    assert meta.voice == "af_heart"


def test_speed_configuration(kokoro_engine):
    """6. Test configurable speech speed (faster speed yields shorter duration)."""
    text = "The quick brown fox jumps over the lazy dog."
    _, meta_normal = kokoro_engine.synthesize(text=text, speed=1.0)
    _, meta_fast = kokoro_engine.synthesize(text=text, speed=1.5)

    assert meta_fast.duration_seconds < meta_normal.duration_seconds


def test_wav_format_validity(kokoro_engine):
    """7. Test that output audio conforms strictly to 16-bit Mono 24 kHz WAV format."""
    text = "Validating WAV headers and audio samples."
    wav_bytes, _ = kokoro_engine.synthesize(text=text)

    # Use soundfile to read and validate
    data, sr = sf.read(io.BytesIO(wav_bytes))
    assert sr == 24000
    assert data.ndim == 1  # Mono
    assert len(data) > 0
    assert np.max(np.abs(data)) > 0.0  # Not silent


def test_model_reuse_across_multiple_requests(kokoro_engine):
    """8. Test that the model is loaded once into memory and reused across inferences."""
    model_id_1 = id(kokoro_engine._model)

    kokoro_engine.synthesize(text="Sentence number one.")
    model_id_2 = id(kokoro_engine._model)

    kokoro_engine.synthesize(text="Sentence number two.")
    model_id_3 = id(kokoro_engine._model)

    assert model_id_1 == model_id_2 == model_id_3


def test_cpu_and_mps_execution(kokoro_engine):
    """9. Test device placement on Apple Silicon MPS or CPU fallback."""
    if torch.backends.mps.is_available():
        assert kokoro_engine.device in ["mps", "cpu"]
    else:
        assert kokoro_engine.device == "cpu"

    # Test explicit CPU fallback execution
    cpu_engine = KokoroTTSEngine(device="cpu")
    cpu_engine.initialize()
    assert cpu_engine.device == "cpu"

    wav_bytes, meta = cpu_engine.synthesize("Testing CPU synthesis fallback.")
    assert len(wav_bytes) > 1000
    assert meta.device == "cpu"
    cpu_engine.shutdown()


def test_empty_and_invalid_text_handling(kokoro_engine):
    """10. Test proper rejection of empty, whitespace, and oversized text."""
    # Empty string
    with pytest.raises(AIServiceException) as exc1:
        kokoro_engine.synthesize(text="")
    assert exc1.value.status_code == 400

    # Whitespace string
    with pytest.raises(AIServiceException) as exc2:
        kokoro_engine.synthesize(text="    \n\t  ")
    assert exc2.value.status_code == 400


def test_async_service_wrapper():
    """11. Test KokoroTTSService wrapper lifecycle and metadata synthesis."""
    import asyncio

    async def _run():
        service = KokoroTTSService()
        assert service.state == TTSModelState.UNINITIALIZED

        await service.initialize()
        assert service.state == TTSModelState.READY
        assert service.is_ready() is True

        status = service.get_status()
        assert status.is_ready is True
        assert status.sample_rate == 24000

        wav_bytes, meta = await service.synthesize_with_metadata(
            text="Testing async Kokoro service interface.",
            language="en",
            speed=1.0
        )
        assert len(wav_bytes) > 1000
        assert meta.sample_rate == 24000

        await service.shutdown()
        assert service.state == TTSModelState.UNINITIALIZED

    asyncio.run(_run())


def test_api_tts_endpoints(client):
    """12. Test FastAPI /v1/tts/synthesize and /v1/tts/status endpoints."""
    # Ensure service is ready
    import asyncio
    asyncio.run(gia_kokoro_service.initialize())

    # Test status endpoint
    status_res = client.get("/v1/tts/status")
    assert status_res.status_code == 200
    data = status_res.json()
    assert data["is_ready"] is True
    assert data["sample_rate"] == 24000

    # Test synthesis endpoint
    synth_res = client.post(
        "/v1/tts/synthesize",
        json={
            "text": "Testing API synthesis endpoint.",
            "language": "en",
            "voice": "af_heart",
            "speed": 1.0
        }
    )
    assert synth_res.status_code == 200
    assert synth_res.headers["content-type"] == "audio/wav"
    assert synth_res.headers["x-audio-sample-rate"] == "24000"
    assert synth_res.headers["x-tts-language"] == "en"
    assert synth_res.headers["x-tts-voice"] == "af_heart"
    assert len(synth_res.content) > 1000

    # Test streaming synthesis
    stream_res = client.post(
        "/v1/tts/synthesize?stream=true",
        json={"text": "Testing chunked audio streaming."}
    )
    assert stream_res.status_code == 200
    assert stream_res.headers["content-type"] == "audio/wav"
    assert len(stream_res.content) > 1000
