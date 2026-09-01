from abc import ABC, abstractmethod
from typing import Tuple, Optional

class SpeechToTextService(ABC):
    """
    Abstract interface for Speech-to-Text (STT) engines.
    Allows different underlying ML models (Whisper, Faster-Whisper, Vosk, DeepSpeech, etc.)
    to be substituted without changing service/route boundaries.
    """

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize and warm up the STT model weights."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Tear down and release STT model resources."""
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """Returns True if the STT engine is loaded and ready to serve requests."""
        pass

    @abstractmethod
    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None
    ) -> Tuple[str, float, str, float]:
        """
        Transcribes raw audio bytes into text.

        Returns:
            Tuple[text, confidence, detected_language, duration_seconds]
        """
        pass
