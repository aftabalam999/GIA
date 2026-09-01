import io
import wave
import pytest
import numpy as np
from app.schemas.vad import VADConfig, VADEventType
from app.services.vad_service import GIAVoiceActivityDetector
from app.services.audio_processor import NormalizedAudio

def make_pcm_chunk(
    duration_ms: float = 100.0,
    sample_rate: int = 16000,
    amplitude: float = 0.5,
    frequency: float = 440.0
) -> bytes:
    num_samples = int(round((duration_ms / 1000.0) * sample_rate))
    if num_samples == 0:
        return b""
    t = np.linspace(0, duration_ms / 1000.0, num_samples, endpoint=False)
    samples = (amplitude * 32767.0 * np.sin(2 * np.pi * frequency * t)).astype(np.int16)
    return samples.tobytes()

def test_no_speech_and_excessive_silence():
    config = VADConfig(
        min_speech_duration_ms=250.0,
        silence_threshold_db=-45.0,
        max_silence_timeout_ms=500.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    
    # 100ms silence chunk
    silence_chunk = make_pcm_chunk(duration_ms=100.0, amplitude=0.0)

    # First 4 chunks: silence
    for _ in range(4):
        res = vad.process_chunk(silence_chunk)
        assert res.event == VADEventType.SILENCE
        assert res.is_speech is False

    # 5th chunk (reaching 500ms continuous silence): EXCESSIVE_SILENCE
    res = vad.process_chunk(silence_chunk)
    assert res.event == VADEventType.EXCESSIVE_SILENCE

def test_short_speech_rejection():
    config = VADConfig(
        min_speech_duration_ms=300.0,
        silence_threshold_db=-45.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    
    speech_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.5)
    silence_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.0)

    # 200ms speech (less than 300ms min requirement)
    res1 = vad.process_chunk(speech_100ms)
    assert res1.event == VADEventType.SILENCE
    res2 = vad.process_chunk(speech_100ms)
    assert res2.event == VADEventType.SILENCE

    # Followed by silence (cancels pending speech trigger)
    res3 = vad.process_chunk(silence_100ms)
    assert res3.event == VADEventType.SILENCE
    assert res3.utterance_completed is False

def test_normal_speech_and_voice_ended():
    config = VADConfig(
        min_speech_duration_ms=200.0,
        silence_threshold_db=-45.0,
        end_of_speech_timeout_ms=300.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    
    speech_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.5)
    silence_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.0)

    # Chunk 1 (100ms speech): pending
    res1 = vad.process_chunk(speech_100ms)
    assert res1.event == VADEventType.SILENCE

    # Chunk 2 (200ms total speech): VOICE_STARTED!
    res2 = vad.process_chunk(speech_100ms)
    assert res2.event == VADEventType.VOICE_STARTED

    # Chunk 3 (300ms total speech): VOICE_ACTIVE
    res3 = vad.process_chunk(speech_100ms)
    assert res3.event == VADEventType.VOICE_ACTIVE

    # Trailing silence (300ms timeout required)
    res4 = vad.process_chunk(silence_100ms)
    assert res4.event == VADEventType.VOICE_ACTIVE
    res5 = vad.process_chunk(silence_100ms)
    assert res5.event == VADEventType.VOICE_ACTIVE

    # 300ms trailing silence reached -> VOICE_ENDED!
    res6 = vad.process_chunk(silence_100ms)
    assert res6.event == VADEventType.VOICE_ENDED
    assert res6.utterance_completed is True

    # Verify pop_utterance_audio returns NormalizedAudio object
    utterance = vad.pop_utterance_audio()
    assert isinstance(utterance, NormalizedAudio)
    assert utterance.sample_rate == 16000
    assert utterance.channels == 1
    assert utterance.duration_seconds > 0.0

def test_multiple_utterances_continuous_mode():
    config = VADConfig(
        min_speech_duration_ms=200.0,
        silence_threshold_db=-45.0,
        end_of_speech_timeout_ms=200.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    
    speech_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.5)
    silence_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.0)

    # Utterance 1
    vad.process_chunk(speech_100ms)
    res_start1 = vad.process_chunk(speech_100ms)
    assert res_start1.event == VADEventType.VOICE_STARTED

    vad.process_chunk(silence_100ms)
    res_end1 = vad.process_chunk(silence_100ms)
    assert res_end1.event == VADEventType.VOICE_ENDED
    assert res_end1.utterance_completed is True

    utt1 = vad.pop_utterance_audio()
    assert utt1 is not None

    # Silence in between utterances
    res_idle = vad.process_chunk(silence_100ms)
    assert res_idle.event == VADEventType.SILENCE

    # Utterance 2 (Voice mode remains ACTIVE in continuous mode!)
    vad.process_chunk(speech_100ms)
    res_start2 = vad.process_chunk(speech_100ms)
    assert res_start2.event == VADEventType.VOICE_STARTED

    vad.process_chunk(silence_100ms)
    res_end2 = vad.process_chunk(silence_100ms)
    assert res_end2.event == VADEventType.VOICE_ENDED
    assert res_end2.utterance_completed is True

    utt2 = vad.pop_utterance_audio()
    assert utt2 is not None

def test_maximum_utterance_duration_cap():
    config = VADConfig(
        min_speech_duration_ms=100.0,
        silence_threshold_db=-45.0,
        max_utterance_duration_ms=500.0
    )
    vad = GIAVoiceActivityDetector(config=config)
    
    speech_100ms = make_pcm_chunk(duration_ms=100.0, amplitude=0.5)

    # 100ms speech -> VOICE_STARTED
    res1 = vad.process_chunk(speech_100ms)
    assert res1.event == VADEventType.VOICE_STARTED

    # 200ms, 300ms, 400ms -> VOICE_ACTIVE
    vad.process_chunk(speech_100ms)
    vad.process_chunk(speech_100ms)
    vad.process_chunk(speech_100ms)

    # 500ms -> Hits max utterance duration cap -> Forced VOICE_ENDED
    res_cap = vad.process_chunk(speech_100ms)
    assert res_cap.event == VADEventType.VOICE_ENDED
    assert res_cap.utterance_completed is True

def test_invalid_audio_chunk():
    vad = GIAVoiceActivityDetector()
    invalid_bytes = b"\x00" * 3  # Odd number of bytes cannot form 16-bit int16 array
    res = vad.process_chunk(invalid_bytes)
    assert res.event == VADEventType.INVALID_AUDIO

def test_vad_api_endpoints(client):
    # Test GET config
    cfg_resp = client.get("/api/v1/vad/config")
    assert cfg_resp.status_code == 200
    assert cfg_resp.json()["min_speech_duration_ms"] == 250.0

    # Test POST process
    speech_pcm = make_pcm_chunk(duration_ms=200.0, amplitude=0.5)
    proc_resp = client.post(
        "/api/v1/vad/process",
        files={"file": ("chunk.pcm", speech_pcm, "application/octet-stream")}
    )
    assert proc_resp.status_code == 200
    assert "event" in proc_resp.json()
