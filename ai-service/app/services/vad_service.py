import io
import wave
import math
import logging
import numpy as np
from enum import Enum
from typing import Optional, Tuple
from app.schemas.vad import VADEventType, VADConfig, VADResult
from app.services.base_vad import VoiceActivityDetector
from app.services.audio_processor import (
    GIAAudioProcessor,
    NormalizedAudio,
    CANONICAL_SAMPLE_RATE,
    CANONICAL_CHANNELS
)
from app.core.exceptions import AudioProcessingException

logger = logging.getLogger("ai_service.vad_service")

class InternalVADState(str, Enum):
    LISTENING_FOR_SPEECH = "LISTENING_FOR_SPEECH"
    SPEECH_IN_PROGRESS = "SPEECH_IN_PROGRESS"

class GIAVoiceActivityDetector(VoiceActivityDetector):
    """
    Independent Voice Activity Detection (VAD) Engine & State Machine.
    Supports continuous voice session tracking, detecting speech start, continuation,
    end-of-speech silence timeouts, excessive silence, and maximum utterance caps.
    """
    def __init__(self, config: Optional[VADConfig] = None, processor: Optional[GIAAudioProcessor] = None):
        self.config = config or VADConfig()
        self.processor = processor or GIAAudioProcessor()
        self._ready = True
        self.reset_state()

    def is_ready(self) -> bool:
        return self._ready

    def reset_state(self) -> None:
        """Resets the state machine buffers without ending the voice mode session."""
        self._state = InternalVADState.LISTENING_FOR_SPEECH
        self._utterance_pcm_buffer = bytearray()
        self._pending_speech_pcm_buffer = bytearray()
        self._pending_speech_ms = 0.0
        self._accumulated_speech_ms = 0.0
        self._trailing_silence_ms = 0.0
        self._continuous_silence_ms = 0.0
        self._completed_utterance_audio: Optional[NormalizedAudio] = None

    def _compute_chunk_metrics(
        self,
        audio_chunk: bytes,
        sample_rate: int = 16000
    ) -> Tuple[np.ndarray, float, float, bool]:
        """
        Parses raw PCM or container chunk, computes duration (ms), RMS volume (dB),
        and returns boolean is_speech flag based on configured threshold.
        """
        if not audio_chunk or len(audio_chunk) == 0:
            raise AudioProcessingException("VAD frame input is empty")

        # Extract int16 PCM array
        try:
            if audio_chunk.startswith(b"RIFF"):
                with wave.open(io.BytesIO(audio_chunk), 'rb') as wav_file:
                    n_frames = wav_file.getnframes()
                    frames = wav_file.readframes(n_frames)
                    audio_np = np.frombuffer(frames, dtype=np.int16)
            else:
                audio_np = np.frombuffer(audio_chunk, dtype=np.int16)
        except Exception as e:
            logger.warning(f"Failed to parse VAD chunk PCM: {e}")
            raise AudioProcessingException(f"Invalid audio chunk for VAD: {str(e)}")

        total_samples = len(audio_np)
        if total_samples == 0:
            raise AudioProcessingException("Invalid audio frame with 0 samples")

        duration_ms = (total_samples / sample_rate) * 1000.0
        samples_float32 = audio_np.astype(np.float32) / 32768.0

        rms = float(np.sqrt(np.mean(samples_float32 ** 2))) if total_samples > 0 else 0.0
        rms_db = float(20.0 * math.log10(rms)) if rms > 1e-7 else -100.0
        is_speech = rms_db >= self.config.silence_threshold_db

        return audio_np, duration_ms, rms_db, is_speech

    async def detect_speech(
        self,
        audio_chunk: bytes,
        sample_rate: int = 16000
    ) -> bool:
        """Evaluates an audio frame for speech energy."""
        try:
            _, _, _, is_speech = self._compute_chunk_metrics(audio_chunk, sample_rate)
            return is_speech
        except Exception:
            return False

    def process_chunk(
        self,
        audio_chunk: bytes,
        sample_rate: int = 16000
    ) -> VADResult:
        """
        Evaluates incoming audio frame through the continuous VAD state machine.
        """
        try:
            audio_np, duration_ms, rms_db, is_speech = self._compute_chunk_metrics(audio_chunk, sample_rate)
        except AudioProcessingException:
            return VADResult(
                event=VADEventType.INVALID_AUDIO,
                is_speech=False,
                rms_db=-100.0,
                duration_ms=0.0,
                utterance_completed=False,
                speech_duration_ms=0.0
            )

        pcm_bytes = audio_np.tobytes()
        event = VADEventType.SILENCE
        utterance_completed = False

        if self._state == InternalVADState.LISTENING_FOR_SPEECH:
            if is_speech:
                self._pending_speech_pcm_buffer.extend(pcm_bytes)
                self._pending_speech_ms += duration_ms
                self._continuous_silence_ms = 0.0

                if self._pending_speech_ms >= self.config.min_speech_duration_ms:
                    # Transition to SPEECH_IN_PROGRESS
                    self._state = InternalVADState.SPEECH_IN_PROGRESS
                    self._utterance_pcm_buffer = bytearray(self._pending_speech_pcm_buffer)
                    self._accumulated_speech_ms = self._pending_speech_ms
                    self._trailing_silence_ms = 0.0
                    self._pending_speech_pcm_buffer.clear()
                    self._pending_speech_ms = 0.0
                    event = VADEventType.VOICE_STARTED
                else:
                    event = VADEventType.SILENCE
            else:
                self._pending_speech_pcm_buffer.clear()
                self._pending_speech_ms = 0.0
                self._continuous_silence_ms += duration_ms

                if self._continuous_silence_ms >= self.config.max_silence_timeout_ms:
                    event = VADEventType.EXCESSIVE_SILENCE
                else:
                    event = VADEventType.SILENCE

        elif self._state == InternalVADState.SPEECH_IN_PROGRESS:
            self._utterance_pcm_buffer.extend(pcm_bytes)

            if is_speech:
                self._accumulated_speech_ms += duration_ms
                self._trailing_silence_ms = 0.0

                if self._accumulated_speech_ms >= self.config.max_utterance_duration_ms:
                    # Force end of utterance due to max length limit
                    event = VADEventType.VOICE_ENDED
                    utterance_completed = True
                    self._finalize_utterance()
                else:
                    event = VADEventType.VOICE_ACTIVE
            else:
                self._trailing_silence_ms += duration_ms

                if self._trailing_silence_ms >= self.config.end_of_speech_timeout_ms:
                    # Normal end of speech detected
                    event = VADEventType.VOICE_ENDED
                    utterance_completed = True
                    self._finalize_utterance()
                else:
                    event = VADEventType.VOICE_ACTIVE

        return VADResult(
            event=event,
            is_speech=is_speech,
            rms_db=round(rms_db, 2),
            duration_ms=round(duration_ms, 2),
            utterance_completed=utterance_completed,
            speech_duration_ms=round(self._accumulated_speech_ms, 2)
        )

    def _finalize_utterance(self) -> None:
        """Wraps the completed utterance buffer into a NormalizedAudio object and resets internal state."""
        wav_io = io.BytesIO()
        with wave.open(wav_io, 'wb') as wav_file:
            wav_file.setnchannels(CANONICAL_CHANNELS)
            wav_file.setsampwidth(2)
            wav_file.setframerate(CANONICAL_SAMPLE_RATE)
            wav_file.writeframes(bytes(self._utterance_pcm_buffer))

        wav_bytes = wav_io.getvalue()
        try:
            self._completed_utterance_audio = self.processor.decode_and_normalize(wav_bytes)
        except Exception as e:
            logger.error(f"Failed to finalize completed utterance audio: {e}")
            self._completed_utterance_audio = None

        # Reset state machine for continuous mode
        self._state = InternalVADState.LISTENING_FOR_SPEECH
        self._utterance_pcm_buffer.clear()
        self._pending_speech_pcm_buffer.clear()
        self._pending_speech_ms = 0.0
        self._accumulated_speech_ms = 0.0
        self._trailing_silence_ms = 0.0
        self._continuous_silence_ms = 0.0

    def pop_utterance_audio(self) -> Optional[NormalizedAudio]:
        """Returns the completed NormalizedAudio utterance and clears the temporary slot."""
        audio = self._completed_utterance_audio
        self._completed_utterance_audio = None
        return audio

gia_vad_service = GIAVoiceActivityDetector()
