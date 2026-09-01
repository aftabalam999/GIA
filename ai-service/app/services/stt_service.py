import math
import time
import asyncio
import logging
import tempfile
import os
from typing import Tuple, Optional, List
from app.core.config import settings
from app.schemas.stt import (
    STTModelState,
    TranscriptionSegment,
    StructuredTranscriptionResult,
    STTStatusResponse
)
from app.services.base_stt import SpeechToTextService
from app.services.audio_processor import gia_audio_processor
from app.core.exceptions import (
    ModelNotReadyException,
    TranscriptionException,
    AudioProcessingException,
    TranscriptionTimeoutException
)

logger = logging.getLogger("ai_service.stt_service")

class WhisperSTTService(SpeechToTextService):
    """
    Isolated Speech-to-Text (STT) Service wrapping ML inference engines (Faster-Whisper / PyTorch).
    Maintains clean model lifecycle management (UNINITIALIZED -> LOADING -> READY / FAILED),
    loads weights ONCE, supports CPU/GPU execution, handles concurrency safely, and exposes structured results.
    """
    def __init__(
        self,
        model_name: Optional[str] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
        timeout_seconds: Optional[float] = None
    ):
        self.model_name = model_name or settings.STT_MODEL_NAME
        self.device = device or settings.STT_DEVICE
        self.compute_type = compute_type or settings.STT_COMPUTE_TYPE
        self.timeout_seconds = timeout_seconds or settings.STT_TIMEOUT_SECONDS
        
        self._state: STTModelState = STTModelState.UNINITIALIZED
        self._model = None
        self._init_error: Optional[str] = None
        self._lifecycle_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    @property
    def state(self) -> STTModelState:
        return self._state

    def is_ready(self) -> bool:
        return self._state == STTModelState.READY

    def get_status(self) -> STTStatusResponse:
        return STTStatusResponse(
            state=self._state,
            model_name=self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            is_ready=self.is_ready(),
            error=self._init_error
        )

    async def initialize(self) -> None:
        """Initializes and loads the STT model weights ONCE into memory."""
        async with self._lifecycle_lock:
            if self._state == STTModelState.READY:
                return

            self._state = STTModelState.LOADING
            self._init_error = None
            logger.info(f"Loading STT model '{self.model_name}' on device '{self.device}' ({self.compute_type})...")

            try:
                from faster_whisper import WhisperModel
                
                loop = asyncio.get_running_loop()
                def _load_model():
                    return WhisperModel(
                        self.model_name,
                        device=self.device,
                        compute_type=self.compute_type,
                        download_root=None
                    )

                self._model = await loop.run_in_executor(None, _load_model)
                self._state = STTModelState.READY
                logger.info(f"STT model '{self.model_name}' successfully loaded and READY.")
            except Exception as e:
                logger.error(f"Failed to initialize STT model '{self.model_name}': {e}")
                self._init_error = str(e)
                self._state = STTModelState.FAILED

    async def shutdown(self) -> None:
        """Tears down and releases STT model memory."""
        async with self._lifecycle_lock:
            logger.info(f"Shutting down STT model '{self.model_name}'...")
            self._model = None
            self._state = STTModelState.UNINITIALIZED
            self._init_error = None

    async def transcribe_structured(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None
    ) -> StructuredTranscriptionResult:
        """
        Main structured transcription entrypoint.
        Validates readiness, normalizes audio, and executes inference safely.
        """
        if not self.is_ready():
            raise ModelNotReadyException(
                f"STT model is not ready to serve requests (State: {self._state.value}). Error: {self._init_error or 'None'}"
            )

        start_time = time.perf_counter()

        # Phase 3 Audio Normalization Pipeline
        normalized = gia_audio_processor.decode_and_normalize(raw_bytes=audio_bytes, filename=filename)

        # Handle silent audio safely
        if normalized.is_silent:
            processing_time = round(time.perf_counter() - start_time, 4)
            return StructuredTranscriptionResult(
                text="",
                language=language or "en",
                confidence=0.0,
                duration=normalized.duration_seconds,
                segments=[],
                processing_time=processing_time
            )

        # Write normalized PCM bytes to temporary file for Whisper decoding
        temp_wav_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
                temp_wav_path = temp_wav.name
                
                import wave
                with wave.open(temp_wav_path, 'wb') as wav_file:
                    wav_file.setnchannels(normalized.channels)
                    wav_file.setsampwidth(2)
                    wav_file.setframerate(normalized.sample_rate)
                    wav_file.writeframes(normalized.pcm_bytes)

            loop = asyncio.get_running_loop()

            def _run_inference():
                segments_raw, info = self._model.transcribe(
                    temp_wav_path,
                    language=language,
                    beam_size=5,
                    word_timestamps=False
                )
                segments_list = list(segments_raw)
                return segments_list, info

            async def _execute_with_lock():
                async with self._inference_lock:
                    return await loop.run_in_executor(None, _run_inference)

            # Apply timeout protection around model inference execution
            try:
                segments_raw, info = await asyncio.wait_for(
                    _execute_with_lock(),
                    timeout=self.timeout_seconds
                )
            except asyncio.TimeoutError:
                logger.error(f"STT transcription timed out after {self.timeout_seconds} seconds")
                raise TranscriptionTimeoutException(
                    f"Speech transcription timed out after {self.timeout_seconds} seconds"
                )

            parsed_segments: List[TranscriptionSegment] = []
            full_text_parts: List[str] = []

            for seg in segments_raw:
                avg_logprob = getattr(seg, 'avg_logprob', 0.0)
                # Map log probability to 0.0 - 1.0 confidence score
                try:
                    conf = round(min(1.0, max(0.0, math.exp(avg_logprob))), 2)
                except Exception:
                    conf = 1.0

                parsed_segments.append(
                    TranscriptionSegment(
                        start=round(seg.start, 2),
                        end=round(seg.end, 2),
                        text=seg.text.strip(),
                        confidence=conf
                    )
                )
                if seg.text.strip():
                    full_text_parts.append(seg.text.strip())

            full_text = " ".join(full_text_parts)
            detected_language = getattr(info, 'language', language or 'en')
            lang_prob = getattr(info, 'language_probability', 1.0)
            overall_confidence = round(min(1.0, max(0.0, float(lang_prob))), 2)
            processing_time = round(time.perf_counter() - start_time, 4)

            return StructuredTranscriptionResult(
                text=full_text,
                language=detected_language,
                confidence=overall_confidence,
                duration=normalized.duration_seconds,
                segments=parsed_segments,
                processing_time=processing_time
            )

        except Exception as e:
            if isinstance(e, (ModelNotReadyException, AudioProcessingException, TranscriptionTimeoutException)):
                raise
            logger.error(f"STT transcription failure: {e}", exc_info=True)
            raise TranscriptionException(f"Speech transcription failed: {str(e)}")
        finally:
            if temp_wav_path and os.path.exists(temp_wav_path):
                try:
                    os.remove(temp_wav_path)
                except Exception:
                    pass

    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None
    ) -> Tuple[str, float, str, float]:
        """Adapter method fulfilling the Phase 2 SpeechToTextService interface contract."""
        res = await self.transcribe_structured(audio_bytes, filename=filename, language=language)
        return (res.text, res.confidence, res.language, res.duration)

gia_stt_service = WhisperSTTService()

