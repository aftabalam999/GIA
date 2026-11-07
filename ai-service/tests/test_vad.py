import io
import wave
import pytest
import numpy as np
from app.schemas.vad import VADConfig, VADEventType
from app.services.silero_vad import SileroVADEngine, SILERO_SAMPLE_RATE, SILERO_STATE_SHAPE
from app.services.vad_service import GIAVoiceActivityDetector
from app.services.audio_processor import NormalizedAudio

def make_speech_pcm(
    duration_ms: float = 100.0,
    start_time: float = 0.0,
    sample_rate: int = 16000,
    amplitude: float = 0.8
) -> bytes:
    """Generates synthetic glottal pulse speech PCM audio with 3Hz syllabic rhythm."""
    num_samples = int(round((duration_ms / 1000.0) * sample_rate))
    if num_samples == 0:
        return b""
    if amplitude == 0.0:
        return np.zeros(num_samples, dtype=np.int16).tobytes()

    t = np.linspace(start_time, start_time + duration_ms / 1000.0, num_samples, endpoint=False)
    # Glottal pulse harmonic series (n=1..14, fundamental=220Hz)
    voice = np.zeros(num_samples)
    for i in range(1, 15):
        voice += (1.0 / i) * np.sin(2 * np.pi * i * 220 * t)
    sig = voice * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))
    peak = np.max(np.abs(sig))
    if peak > 0:
        sig = sig / peak
    samples = (amplitude * 32767.0 * sig).astype(np.int16)
    return samples.tobytes()

def make_silence_pcm(
    duration_ms: float = 100.0,
    sample_rate: int = 16000
) -> bytes:
    """Generates pure zero-amplitude PCM audio."""
    num_samples = int(round((duration_ms / 1000.0) * sample_rate))
    return np.zeros(num_samples, dtype=np.int16).tobytes()

# ---------------------------------------------------------------------------
# 1. Model Initialization
# ---------------------------------------------------------------------------
def test_silero_model_initialization():
    engine = SileroVADEngine()
    assert engine.is_ready() is True
    assert engine._session is not None
    state = engine.get_state()
    assert state.shape == SILERO_STATE_SHAPE
    assert np.all(state == 0.0)

# ---------------------------------------------------------------------------
# 2. Silence Detection
# ---------------------------------------------------------------------------
def test_silero_silence_detection():
    config = VADConfig(
        use_silero=True,
        speech_threshold=0.5,
        min_speech_duration_ms=250.0,
        max_silence_timeout_ms=500.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    silence_100ms = make_silence_pcm(100.0)

    # 4 consecutive silence chunks
    for _ in range(4):
        res = vad.process_chunk(silence_100ms)
        assert res.event == VADEventType.SILENCE
        assert res.is_speech is False
        assert res.speech_probability < 0.1

    # 5th chunk reaches 500ms max silence timeout
    res_excessive = vad.process_chunk(silence_100ms)
    assert res_excessive.event == VADEventType.EXCESSIVE_SILENCE
    assert res_excessive.is_speech is False

# ---------------------------------------------------------------------------
# 3. Speech Detection
# ---------------------------------------------------------------------------
def test_silero_speech_detection():
    config = VADConfig(
        use_silero=True,
        speech_threshold=0.5,
        min_speech_duration_ms=100.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    speech_100ms = make_speech_pcm(100.0, amplitude=0.8)

    res = vad.process_chunk(speech_100ms)
    assert res.speech_probability >= 0.5
    assert res.is_speech is True

# ---------------------------------------------------------------------------
# 4. Speech-Start Events (VOICE_STARTED)
# ---------------------------------------------------------------------------
def test_speech_start_event():
    config = VADConfig(
        use_silero=True,
        speech_threshold=0.5,
        min_speech_duration_ms=200.0,
        end_of_speech_timeout_ms=300.0
    )
    vad = GIAVoiceActivityDetector(config=config)

    # Chunk 1 (100ms speech): pending speech (100ms < 200ms min) -> SILENCE
    res1 = vad.process_chunk(make_speech_pcm(100.0, start_time=0.0))
    assert res1.is_speech is True
    assert res1.event == VADEventType.SILENCE

    # Chunk 2 (200ms total speech >= min_speech_duration): VOICE_STARTED!
    res2 = vad.process_chunk(make_speech_pcm(100.0, start_time=0.1))
    assert res2.is_speech is True
    assert res2.event == VADEventType.VOICE_STARTED

# ---------------------------------------------------------------------------
# 5. Speech-End Events (VOICE_ENDED)
# ---------------------------------------------------------------------------
def test_speech_end_event():
    config = VADConfig(
        use_silero=True,
        speech_threshold=0.5,
        min_speech_duration_ms=200.0,
        end_of_speech_timeout_ms=300.0
    )
    vad = GIAVoiceActivityDetector(config=config)

    # Utterance start (200ms)
    vad.process_chunk(make_speech_pcm(100.0, start_time=0.0))
    res_start = vad.process_chunk(make_speech_pcm(100.0, start_time=0.1))
    assert res_start.event == VADEventType.VOICE_STARTED

    # Continuation (300ms total)
    res_active = vad.process_chunk(make_speech_pcm(100.0, start_time=0.2))
    assert res_active.event == VADEventType.VOICE_ACTIVE

    # Feed trailing silence chunks until timeout triggers VOICE_ENDED
    events = []
    for _ in range(5):
        res_sil = vad.process_chunk(make_silence_pcm(100.0))
        events.append(res_sil.event)
        if res_sil.event == VADEventType.VOICE_ENDED:
            assert res_sil.utterance_completed is True
            break

    assert VADEventType.VOICE_ENDED in events

    # Validate generated NormalizedAudio
    utterance = vad.pop_utterance_audio()
    assert isinstance(utterance, NormalizedAudio)
    assert utterance.sample_rate == 16000
    assert utterance.duration_seconds > 0.0

# ---------------------------------------------------------------------------
# 6. Consecutive Audio Chunks & Arbitrary Framing
# ---------------------------------------------------------------------------
def test_consecutive_audio_chunks_and_leftover():
    engine = SileroVADEngine()
    # 600 samples is NOT a multiple of 512 (512 + 88 leftover)
    chunk1 = np.zeros(600, dtype=np.float32)
    max_prob1, probs1, n_frames1 = engine.process_audio_chunk(chunk1)
    assert n_frames1 == 1
    assert len(engine._leftover) == 88

    # Second chunk has 424 samples (88 leftover + 424 = 512 -> exact 1 frame)
    chunk2 = np.zeros(424, dtype=np.float32)
    max_prob2, probs2, n_frames2 = engine.process_audio_chunk(chunk2)
    assert n_frames2 == 1
    assert len(engine._leftover) == 0

# ---------------------------------------------------------------------------
# 7. Model State Reset
# ---------------------------------------------------------------------------
def test_model_state_reset():
    engine = SileroVADEngine()
    speech = np.frombuffer(make_speech_pcm(300.0), dtype=np.int16).astype(np.float32) / 32768.0

    # Process speech
    engine.process_audio_chunk(speech)
    state_after = engine.get_state()
    # Hidden state must have been updated
    assert np.linalg.norm(state_after) > 0.0

    # Reset
    engine.reset_state()
    state_reset = engine.get_state()
    assert np.all(state_reset == 0.0)
    assert len(engine._leftover) == 0

# ---------------------------------------------------------------------------
# 8. Invalid Audio Input Handling
# ---------------------------------------------------------------------------
def test_invalid_audio_input():
    vad = GIAVoiceActivityDetector()

    # Odd byte length (invalid for 16-bit PCM)
    res_odd = vad.process_chunk(b"\x00\x01\x02")
    assert res_odd.event == VADEventType.INVALID_AUDIO

    # Empty payload
    res_empty = vad.process_chunk(b"")
    assert res_empty.event == VADEventType.INVALID_AUDIO

# ---------------------------------------------------------------------------
# 9. Incorrect Sample Rate Handling
# ---------------------------------------------------------------------------
def test_incorrect_sample_rate_handling():
    vad = GIAVoiceActivityDetector()
    valid_pcm = make_silence_pcm(100.0)

    # Negative / zero sample rate
    res_zero = vad.process_chunk(valid_pcm, sample_rate=0)
    assert res_zero.event == VADEventType.INVALID_AUDIO

    # Unsupported sample rate for Silero
    res_wrong = vad.process_chunk(valid_pcm, sample_rate=44100)
    assert res_wrong.event == VADEventType.INVALID_AUDIO

# ---------------------------------------------------------------------------
# 10. Maximum Utterance Duration Cap
# ---------------------------------------------------------------------------
def test_maximum_utterance_duration_cap():
    config = VADConfig(
        use_silero=True,
        speech_threshold=0.5,
        min_speech_duration_ms=100.0,
        max_utterance_duration_ms=400.0
    )
    vad = GIAVoiceActivityDetector(config=config)

    # 100ms -> VOICE_STARTED
    res1 = vad.process_chunk(make_speech_pcm(100.0, start_time=0.0))
    assert res1.event == VADEventType.VOICE_STARTED

    # 200ms, 300ms -> VOICE_ACTIVE
    vad.process_chunk(make_speech_pcm(100.0, start_time=0.1))
    vad.process_chunk(make_speech_pcm(100.0, start_time=0.2))

    # 400ms hits cap -> Forced VOICE_ENDED
    res_cap = vad.process_chunk(make_speech_pcm(100.0, start_time=0.3))
    assert res_cap.event == VADEventType.VOICE_ENDED
    assert res_cap.utterance_completed is True

# ---------------------------------------------------------------------------
# 11. Energy Fallback Mode
# ---------------------------------------------------------------------------
def test_energy_fallback_when_silero_disabled():
    config = VADConfig(
        use_silero=False,
        silence_threshold_db=-45.0,
        min_speech_duration_ms=100.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    pcm = make_speech_pcm(100.0, amplitude=0.8)
    res = vad.process_chunk(pcm)
    assert res.is_speech is True
    assert res.rms_db > -45.0

# ---------------------------------------------------------------------------
# 12. API Endpoints
# ---------------------------------------------------------------------------
def test_vad_api_endpoints(client):
    # Test GET config
    cfg_resp = client.get("/api/v1/vad/config")
    assert cfg_resp.status_code == 200
    data = cfg_resp.json()
    assert "speech_threshold" in data
    assert "use_silero" in data

    # Test POST config update
    update_resp = client.post("/api/v1/vad/config", json={
        "speech_threshold": 0.45,
        "min_speech_duration_ms": 200.0,
        "use_silero": True
    })
    assert update_resp.status_code == 200
    assert update_resp.json()["speech_threshold"] == 0.45

    # Test POST process
    speech_pcm = make_speech_pcm(duration_ms=200.0, amplitude=0.8)
    proc_resp = client.post(
        "/api/v1/vad/process",
        files={"file": ("chunk.pcm", speech_pcm, "application/octet-stream")}
    )
    assert proc_resp.status_code == 200
    result_data = proc_resp.json()
    assert "event" in result_data
    assert "speech_probability" in result_data
