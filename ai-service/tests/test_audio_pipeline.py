import io
import wave
import pytest
import numpy as np
from app.services.audio_processor import (
    GIAAudioProcessor,
    NormalizedAudio,
    CANONICAL_SAMPLE_RATE,
    CANONICAL_CHANNELS
)
from app.services.audio_buffer import AudioChunkBuffer
from app.core.exceptions import AudioProcessingException

def create_synthetic_wav(
    duration_seconds: float = 1.0,
    sample_rate: int = 16000,
    channels: int = 1,
    frequency: float = 440.0,
    amplitude: float = 0.5
) -> bytes:
    num_samples = int(round(duration_seconds * sample_rate))
    t = np.linspace(0, duration_seconds, num_samples, endpoint=False)
    samples = (amplitude * 32767.0 * np.sin(2 * np.pi * frequency * t)).astype(np.int16)
    
    if channels > 1:
        samples = np.repeat(samples[:, np.newaxis], channels, axis=1).flatten()
        
    wav_io = io.BytesIO()
    with wave.open(wav_io, 'wb') as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples.tobytes())
    return wav_io.getvalue()

def test_valid_audio_normalization():
    processor = GIAAudioProcessor()
    wav_bytes = create_synthetic_wav(duration_seconds=1.5, sample_rate=16000, channels=1)
    
    normalized = processor.decode_and_normalize(wav_bytes)
    assert isinstance(normalized, NormalizedAudio)
    assert normalized.sample_rate == CANONICAL_SAMPLE_RATE
    assert normalized.channels == CANONICAL_CHANNELS
    assert abs(normalized.duration_seconds - 1.5) < 0.05
    assert normalized.is_silent is False
    assert len(normalized.pcm_bytes) > 0
    assert isinstance(normalized.samples_float32, np.ndarray)

def test_stereo_to_mono_and_resampling():
    processor = GIAAudioProcessor()
    # 44.1kHz stereo audio input
    wav_bytes = create_synthetic_wav(duration_seconds=1.0, sample_rate=44100, channels=2)
    
    normalized = processor.decode_and_normalize(wav_bytes)
    assert normalized.sample_rate == 16000
    assert normalized.channels == 1
    assert abs(normalized.duration_seconds - 1.0) < 0.05

def test_silence_detection():
    processor = GIAAudioProcessor()
    # Zero amplitude audio (silence)
    silent_wav = create_synthetic_wav(duration_seconds=1.0, amplitude=0.0)
    
    normalized = processor.decode_and_normalize(silent_wav)
    assert normalized.is_silent is True
    assert normalized.rms_db < -45.0

def test_short_audio_rejection():
    processor = GIAAudioProcessor()
    # Audio shorter than 0.1s (0.05s)
    short_wav = create_synthetic_wav(duration_seconds=0.05)
    
    with pytest.raises(AudioProcessingException) as exc_info:
        processor.decode_and_normalize(short_wav)
    assert "shorter than minimum required" in str(exc_info.value)

def test_long_audio_rejection():
    processor = GIAAudioProcessor()
    # Mock duration check using small byte array to trigger duration limit
    # 301 seconds * 16000 samples * 2 bytes = ~9.6 MB PCM
    samples = np.zeros(301 * 16000, dtype=np.int16)
    wav_io = io.BytesIO()
    with wave.open(wav_io, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(samples.tobytes())
    long_wav = wav_io.getvalue()

    with pytest.raises(AudioProcessingException) as exc_info:
        processor.decode_and_normalize(long_wav)
    assert "exceeds maximum allowed" in str(exc_info.value)

def test_corrupted_payload_rejection():
    processor = GIAAudioProcessor()
    corrupted_bytes = b"GARBAGE_NOT_AUDIO_DATA_HEADER"
    
    with pytest.raises(AudioProcessingException) as exc_info:
        processor.decode_and_normalize(corrupted_bytes)
    assert "Corrupted or unsupported audio format" in str(exc_info.value) or "empty" in str(exc_info.value)

def test_empty_payload_rejection():
    processor = GIAAudioProcessor()
    with pytest.raises(AudioProcessingException) as exc_info:
        processor.decode_and_normalize(b"")
    assert "empty" in str(exc_info.value)

def test_oversized_payload_rejection():
    processor = GIAAudioProcessor()
    oversized_bytes = b"\x00" * (25 * 1024 * 1024 + 1)
    with pytest.raises(AudioProcessingException) as exc_info:
        processor.decode_and_normalize(oversized_bytes)
    assert "exceeds maximum limit" in str(exc_info.value)

def test_audio_chunk_buffer():
    buffer = AudioChunkBuffer()

    # Generate 1.0 second of 16kHz int16 PCM raw bytes
    samples = (0.5 * 32767.0 * np.sin(2 * np.pi * 440.0 * np.linspace(0, 1.0, 16000))).astype(np.int16)
    pcm_raw = samples.tobytes()

    # Append in two 0.5s chunks
    buffer.append_chunk(pcm_raw[:16000])
    buffer.append_chunk(pcm_raw[16000:])
    assert buffer.buffered_bytes_length == 32000

    normalized = buffer.get_normalized_audio()
    assert normalized.sample_rate == 16000
    assert normalized.channels == 1
    assert abs(normalized.duration_seconds - 1.0) < 0.05
    assert normalized.is_silent is False

def test_audio_validation_endpoint(client):
    wav_bytes = create_synthetic_wav(duration_seconds=1.2, sample_rate=16000)
    response = client.post(
        "/api/v1/audio/validate",
        files={"file": ("test.wav", wav_bytes, "audio/wav")}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["valid"] is True
    assert data["sample_rate"] == 16000
    assert data["channels"] == 1
    assert abs(data["duration_seconds"] - 1.2) < 0.05
    assert data["is_silent"] is False
