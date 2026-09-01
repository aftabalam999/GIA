import logging
from typing import Dict, Optional
from app.services.base_stt import SpeechToTextService
from app.services.base_tts import TextToSpeechService
from app.services.base_audio import AudioProcessor
from app.services.base_vad import VoiceActivityDetector
from app.services.base_embedding import EmbeddingService
from app.services.base_reranker import RerankerService

logger = logging.getLogger("ai_service.models.lifecycle")

class ModelLifecycleManager:
    """
    Manages the initialization, readiness monitoring, and teardown lifecycle
    for ML models and audio/RAG subsystem engines.
    """
    def __init__(self):
        self._stt_service: Optional[SpeechToTextService] = None
        self._tts_service: Optional[TextToSpeechService] = None
        self._audio_processor: Optional[AudioProcessor] = None
        self._vad_service: Optional[VoiceActivityDetector] = None
        self._embedding_service: Optional[EmbeddingService] = None
        self._reranker_service: Optional[RerankerService] = None

    def register_stt_service(self, service: SpeechToTextService):
        self._stt_service = service
        logger.info(f"Registered STT Service: {service.__class__.__name__}")

    def register_tts_service(self, service: TextToSpeechService):
        self._tts_service = service
        logger.info(f"Registered TTS Service: {service.__class__.__name__}")

    def register_audio_processor(self, processor: AudioProcessor):
        self._audio_processor = processor
        logger.info(f"Registered Audio Processor: {processor.__class__.__name__}")

    def register_vad_service(self, service: VoiceActivityDetector):
        self._vad_service = service
        logger.info(f"Registered VAD Service: {service.__class__.__name__}")

    def register_embedding_service(self, service: EmbeddingService):
        self._embedding_service = service
        logger.info(f"Registered Embedding Service: {service.__class__.__name__}")

    def register_reranker_service(self, service: RerankerService):
        self._reranker_service = service
        logger.info(f"Registered Reranker Service: {service.__class__.__name__}")

    @property
    def stt_service(self) -> Optional[SpeechToTextService]:
        return self._stt_service

    @property
    def tts_service(self) -> Optional[TextToSpeechService]:
        return self._tts_service

    @property
    def audio_processor(self) -> Optional[AudioProcessor]:
        return self._audio_processor

    @property
    def vad_service(self) -> Optional[VoiceActivityDetector]:
        return self._vad_service

    @property
    def embedding_service(self) -> Optional[EmbeddingService]:
        return self._embedding_service

    @property
    def reranker_service(self) -> Optional[RerankerService]:
        return self._reranker_service

    async def startup(self) -> None:
        """Startup hook: Initializes all registered ML models."""
        logger.info("Initializing ML model subsystems...")
        if self._stt_service:
            try:
                await self._stt_service.initialize()
            except Exception as e:
                logger.error(f"STT Service initialization error: {e}")

        if self._tts_service:
            try:
                await self._tts_service.initialize()
            except Exception as e:
                logger.error(f"TTS Service initialization error: {e}")

        if self._embedding_service:
            try:
                await self._embedding_service.initialize()
            except Exception as e:
                logger.error(f"Embedding Service initialization error: {e}")

        if self._reranker_service:
            try:
                await self._reranker_service.initialize()
            except Exception as e:
                logger.error(f"Reranker Service initialization error: {e}")

    async def shutdown(self) -> None:
        """Shutdown hook: Releases resources for all registered ML models."""
        logger.info("Shutting down ML model subsystems...")
        if self._stt_service:
            try:
                await self._stt_service.shutdown()
            except Exception as e:
                logger.error(f"STT Service shutdown error: {e}")

        if self._tts_service:
            try:
                await self._tts_service.shutdown()
            except Exception as e:
                logger.error(f"TTS Service shutdown error: {e}")

        if self._embedding_service:
            try:
                await self._embedding_service.shutdown()
            except Exception as e:
                logger.error(f"Embedding Service shutdown error: {e}")

        if self._reranker_service:
            try:
                await self._reranker_service.shutdown()
            except Exception as e:
                logger.error(f"Reranker Service shutdown error: {e}")

    def get_subsystem_statuses(self) -> Dict[str, bool]:
        """Returns readiness status for all registered subsystems."""
        return {
            "audio_processor": self._audio_processor is not None,
            "vad": self._vad_service.is_ready() if self._vad_service else False,
            "stt": self._stt_service.is_ready() if self._stt_service else False,
            "tts": self._tts_service.is_ready() if self._tts_service else False,
            "embedding": self._embedding_service.is_ready() if self._embedding_service else False,
            "reranker": self._reranker_service.is_ready() if self._reranker_service else False,
        }

    def is_overall_ready(self) -> bool:
        """Returns True if all required model subsystems are ready for inference."""
        statuses = self.get_subsystem_statuses()
        core_keys = ["audio_processor", "vad", "stt", "tts", "embedding", "reranker"]
        return all(statuses.get(k, False) for k in core_keys)

model_lifecycle = ModelLifecycleManager()

# Register default core audio, VAD, STT, TTS, Embedding, and Reranker services
from app.services.audio_processor import gia_audio_processor
from app.services.vad_service import gia_vad_service
from app.services.stt_service import gia_stt_service
from app.services.tts_service import gia_tts_service
from app.services.embedding_service import gia_embedding_service
from app.services.reranker_service import gia_reranker_service

model_lifecycle.register_audio_processor(gia_audio_processor)
model_lifecycle.register_vad_service(gia_vad_service)
model_lifecycle.register_stt_service(gia_stt_service)
model_lifecycle.register_tts_service(gia_tts_service)
model_lifecycle.register_embedding_service(gia_embedding_service)
model_lifecycle.register_reranker_service(gia_reranker_service)
