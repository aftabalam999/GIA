import math
import time
import asyncio
import logging
from typing import Tuple, Optional, List
import numpy as np

from app.core.config import settings
from app.schemas.stt import (
    STTModelState,
    TranscriptionSegment,
    StructuredTranscriptionResult,
    STTStatusResponse
)
from app.services.base_stt import SpeechToTextService
from app.services.whisper_ggml import WhisperGGMLEngine, WHISPER_SAMPLE_RATE
from app.services.audio_processor import gia_audio_processor, NormalizedAudio
from app.core.exceptions import (
    ModelNotReadyException,
    TranscriptionException,
    AudioProcessingException,
    TranscriptionTimeoutException
)

logger = logging.getLogger("ai_service.stt_service")

class WhisperSTTService(SpeechToTextService):
    """
    Speech-to-Text (STT) Service wrapping local Whisper GGML models via whisper.cpp.
    - Loads quantized GGML weights ONCE into memory with Apple Silicon Metal acceleration.
    - Manages clean lifecycle transitions (UNINITIALIZED -> LOADING -> READY / FAILED).
    - Supports English, Hindi, mixed speech, and automatic language detection.
    - Integrates directly with Silero VAD by ingesting NormalizedAudio utterances without file I/O.
    - Guards inference with timeout protection, concurrency locks, and structured error reporting.
    """

    def __init__(
        self,
        model_name: Optional[str] = None,
        model_path: Optional[str] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
        timeout_seconds: Optional[float] = None
    ):
        self.model_name = model_name or getattr(settings, "STT_MODEL_NAME", "small")
        self.model_path = model_path or getattr(settings, "STT_MODEL_PATH", "models/STT/ggml-small-q5_1.bin")
        self.device = device or getattr(settings, "STT_DEVICE", "auto")
        self.compute_type = compute_type or getattr(settings, "STT_COMPUTE_TYPE", "q5_1")
        self.timeout_seconds = timeout_seconds or getattr(settings, "STT_TIMEOUT_SECONDS", 30.0)

        self._state: STTModelState = STTModelState.UNINITIALIZED
        self._engine: WhisperGGMLEngine = WhisperGGMLEngine(model_path=self.model_path)
        self._init_error: Optional[str] = None
        self._lifecycle_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    @property
    def state(self) -> STTModelState:
        return self._state

    def is_ready(self) -> bool:
        return self._state == STTModelState.READY and self._engine.is_ready()

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
        """Initializes and loads the Whisper GGML model weights ONCE into memory."""
        async with self._lifecycle_lock:
            if self.is_ready():
                return

            self._state = STTModelState.LOADING
            self._init_error = None
            logger.info(f"Initializing Whisper STT model '{self.model_name}' ({self.compute_type}) on device '{self.device}'...")

            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._engine.initialize)
                self._state = STTModelState.READY
                logger.info(f"Whisper STT model '{self.model_name}' successfully loaded and READY.")
            except Exception as e:
                logger.error(f"Failed to initialize Whisper STT model '{self.model_name}': {e}")
                self._init_error = str(e)
                self._state = STTModelState.FAILED
                raise

    async def shutdown(self) -> None:
        """Tears down and releases Whisper model memory."""
        async with self._lifecycle_lock:
            logger.info(f"Shutting down Whisper STT model '{self.model_name}'...")
            self._engine.shutdown()
            self._state = STTModelState.UNINITIALIZED
            self._init_error = None

    async def transcribe_utterance(
        self,
        utterance: NormalizedAudio,
        language: Optional[str] = None
    ) -> StructuredTranscriptionResult:
        """
        Directly transcribes a completed NormalizedAudio utterance from Silero VAD.
        Eliminates disk I/O and container re-encoding by passing float32 samples directly to Whisper.
        """
        if not self.is_ready():
            raise ModelNotReadyException(
                f"STT model is not ready to serve requests (State: {self._state.value}). Error: {self._init_error or 'None'}"
            )

        if utterance.sample_rate != WHISPER_SAMPLE_RATE:
            raise AudioProcessingException(
                f"Whisper STT requires sample rate {WHISPER_SAMPLE_RATE} Hz, received {utterance.sample_rate} Hz"
            )

        start_time = time.perf_counter()

        # Handle silent utterance safely
        if utterance.is_silent or len(utterance.samples_float32) == 0:
            processing_time = round(time.perf_counter() - start_time, 4)
            return StructuredTranscriptionResult(
                text="",
                language=language or "en",
                confidence=0.0,
                duration=utterance.duration_seconds,
                segments=[],
                processing_time=processing_time
            )

        loop = asyncio.get_running_loop()

        def _run_inference():
            return self._engine.transcribe_samples(
                audio_samples_f32=utterance.samples_float32,
                language=language
            )

        async def _execute_with_lock():
            async with self._inference_lock:
                return await loop.run_in_executor(None, _run_inference)

        try:
            full_text, detected_lang, confidence, segments = await asyncio.wait_for(
                _execute_with_lock(),
                timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError:
            logger.error(f"STT transcription timed out after {self.timeout_seconds} seconds")
            raise TranscriptionTimeoutException(
                f"Speech transcription timed out after {self.timeout_seconds} seconds"
            )
        except Exception as e:
            if isinstance(e, (ModelNotReadyException, AudioProcessingException, TranscriptionTimeoutException)):
                raise
            logger.error(f"STT utterance transcription failure: {e}", exc_info=True)
            raise TranscriptionException(f"Speech transcription failed: {str(e)}")

        processing_time = round(time.perf_counter() - start_time, 4)
        logger.info(
            f"[AUDIO_PIPELINE] STT transcribed {utterance.duration_seconds}s audio in {processing_time}s "
            f"(lang: {detected_lang}, confidence: {confidence:.2f}, text_chars: {len(full_text)})"
        )
        return StructuredTranscriptionResult(
            text=full_text,
            language=detected_lang,
            confidence=confidence,
            duration=utterance.duration_seconds,
            segments=segments,
            processing_time=processing_time
        )

    async def transcribe_structured(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None
    ) -> StructuredTranscriptionResult:
        """
        Transcribes raw audio bytes (WAV, MP3, WebM, OGG, FLAC, PCM).
        Validates payload, normalizes audio to 16 kHz Mono float32, and runs inference.
        """
        if not self.is_ready():
            raise ModelNotReadyException(
                f"STT model is not ready to serve requests (State: {self._state.value}). Error: {self._init_error or 'None'}"
            )

        # Normalize audio input via canonical audio processor
        logger.info(
            f"[AUDIO_PIPELINE] Decoding {len(audio_bytes)} bytes ('{filename}'), language={language or 'auto'}..."
        )
        normalized = gia_audio_processor.decode_and_normalize(raw_bytes=audio_bytes, filename=filename)
        logger.info(
            f"[AUDIO_PIPELINE] Normalized: {normalized.duration_seconds}s @ {normalized.sample_rate}Hz mono, "
            f"rms={normalized.rms_db}dB, silent={normalized.is_silent}"
        )
        return await self.transcribe_utterance(utterance=normalized, language=language)

    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None
    ) -> Tuple[str, float, str, float]:
        """Adapter method fulfilling the SpeechToTextService interface contract."""
        res = await self.transcribe_structured(audio_bytes, filename=filename, language=language)
        return (res.text, res.confidence, res.language, res.duration)

gia_stt_service = WhisperSTTService()
