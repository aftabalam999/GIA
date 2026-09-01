import io
import wave
import math
import logging
import numpy as np
import scipy.signal
import av
from dataclasses import dataclass
from typing import Optional
from app.services.base_audio import AudioProcessor
from app.core.exceptions import AudioProcessingException

logger = logging.getLogger("ai_service.audio_processor")

CANONICAL_SAMPLE_RATE = 16000
CANONICAL_CHANNELS = 1
MIN_DURATION_SECONDS = 0.1
MAX_DURATION_SECONDS = 300.0
MAX_PAYLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
SILENCE_THRESHOLD_DB = -45.0

@dataclass
class NormalizedAudio:
    pcm_bytes: bytes           # 16-bit signed LE PCM bytes (16kHz Mono)
    samples_float32: np.ndarray# float32 numpy array normalized to [-1.0, 1.0] at 16kHz
    sample_rate: int = CANONICAL_SAMPLE_RATE
    channels: int = CANONICAL_CHANNELS
    duration_seconds: float = 0.0
    rms_db: float = -100.0
    is_silent: bool = False

class GIAAudioProcessor(AudioProcessor):
    """
    Canonical GIA Audio Pipeline Processor.
    Decodes audio containers (WAV, MP3, WebM, OGG, FLAC, AAC), converts to mono,
    resamples to 16kHz, normalizes amplitude to float32 [-1.0, 1.0] and 16-bit PCM,
    and performs duration, RMS energy, and silence validation.
    """

    def validate_payload_size(self, raw_bytes: bytes) -> None:
        if not raw_bytes or len(raw_bytes) == 0:
            raise AudioProcessingException("Audio payload is empty")
        if len(raw_bytes) > MAX_PAYLOAD_BYTES:
            raise AudioProcessingException(
                f"Audio payload size {len(raw_bytes)} bytes exceeds maximum limit of {MAX_PAYLOAD_BYTES} bytes"
            )

    def decode_and_normalize(self, raw_bytes: bytes, filename: str = "audio.wav") -> NormalizedAudio:
        self.validate_payload_size(raw_bytes)

        # Attempt decoding via PyAV first for universal container support (WAV, MP3, WebM, OGG, FLAC)
        try:
            container = av.open(io.BytesIO(raw_bytes))
            audio_streams = [s for s in container.streams if s.type == 'audio']
            if not audio_streams:
                raise AudioProcessingException("No valid audio stream found in payload")

            stream = audio_streams[0]
            resampler = av.AudioResampler(
                format='s16',
                layout='mono',
                rate=CANONICAL_SAMPLE_RATE
            )

            frames = []
            for packet in container.demux(stream):
                for frame in packet.decode():
                    resampled_frames = resampler.resample(frame)
                    if resampled_frames:
                        for rframe in resampled_frames:
                            frames.append(rframe.to_ndarray())

            if not frames:
                raise AudioProcessingException("Could not decode audio frames from payload")

            # Concatenate resampled PCM int16 arrays
            audio_np = np.concatenate(frames, axis=1).squeeze() if len(frames[0].shape) > 1 else np.concatenate(frames)
            
            # Ensure 1D int16 array
            if audio_np.ndim > 1:
                audio_np = audio_np.mean(axis=0).astype(np.int16)
            else:
                audio_np = audio_np.astype(np.int16)

        except Exception as e:
            if isinstance(e, AudioProcessingException):
                raise
            logger.warning(f"PyAV decoding failed ({e}). Attempting standard WAV fallback...")
            audio_np = self._decode_wav_fallback(raw_bytes)

        total_samples = len(audio_np)
        duration_seconds = total_samples / CANONICAL_SAMPLE_RATE

        if duration_seconds < MIN_DURATION_SECONDS:
            raise AudioProcessingException(
                f"Audio duration ({duration_seconds:.3f}s) is shorter than minimum required ({MIN_DURATION_SECONDS}s)"
            )
        if duration_seconds > MAX_DURATION_SECONDS:
            raise AudioProcessingException(
                f"Audio duration ({duration_seconds:.3f}s) exceeds maximum allowed ({MAX_DURATION_SECONDS}s)"
            )

        # Convert int16 -> float32 [-1.0, 1.0]
        samples_float32 = audio_np.astype(np.float32) / 32768.0

        # Calculate RMS & dB level
        rms = float(np.sqrt(np.mean(samples_float32 ** 2))) if total_samples > 0 else 0.0
        rms_db = float(20.0 * math.log10(rms)) if rms > 1e-7 else -100.0
        is_silent = rms_db < SILENCE_THRESHOLD_DB

        pcm_bytes = audio_np.tobytes()

        return NormalizedAudio(
            pcm_bytes=pcm_bytes,
            samples_float32=samples_float32,
            sample_rate=CANONICAL_SAMPLE_RATE,
            channels=CANONICAL_CHANNELS,
            duration_seconds=round(duration_seconds, 3),
            rms_db=round(rms_db, 2),
            is_silent=is_silent
        )

    def _decode_wav_fallback(self, raw_bytes: bytes) -> np.ndarray:
        try:
            with wave.open(io.BytesIO(raw_bytes), 'rb') as wav_file:
                sample_rate = wav_file.getframerate()
                n_channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                n_frames = wav_file.getnframes()
                frames = wav_file.readframes(n_frames)

                if sample_width == 2:
                    dtype = np.int16
                elif sample_width == 1:
                    dtype = np.uint8
                elif sample_width == 4:
                    dtype = np.int32
                else:
                    raise AudioProcessingException(f"Unsupported WAV sample width: {sample_width}")

                data = np.frombuffer(frames, dtype=dtype)
                if sample_width == 1:
                    data = ((data.astype(np.float32) - 128.0) * 256.0).astype(np.int16)
                elif sample_width == 4:
                    data = (data / 65536.0).astype(np.int16)

                if n_channels > 1:
                    data = data.reshape(-1, n_channels).mean(axis=1).astype(np.int16)

                if sample_rate != CANONICAL_SAMPLE_RATE:
                    num_target_samples = int(round(len(data) * CANONICAL_SAMPLE_RATE / sample_rate))
                    data = scipy.signal.resample(data, num_target_samples).astype(np.int16)

                return data
        except Exception as err:
            if isinstance(err, AudioProcessingException):
                raise
            raise AudioProcessingException(f"Corrupted or unsupported audio format: {err}")

    async def process_audio(
        self,
        raw_bytes: bytes,
        target_sample_rate: int = 16000,
        target_channels: int = 1
    ) -> bytes:
        normalized = self.decode_and_normalize(raw_bytes)
        return normalized.pcm_bytes

    async def get_duration(self, raw_bytes: bytes) -> float:
        normalized = self.decode_and_normalize(raw_bytes)
        return normalized.duration_seconds

gia_audio_processor = GIAAudioProcessor()
