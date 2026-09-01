from abc import ABC, abstractmethod
from typing import Optional

class TextToSpeechService(ABC):
    """
    Abstract interface for Text-to-Speech (TTS) engines.
    Allows different underlying ML synthesis models (Piper, Edge-TTS, Coqui, PyTTSx3, Bark, etc.)
    to be substituted without changing service/route boundaries.
    """

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize and warm up the TTS synthesis engine."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Tear down and release TTS model resources."""
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """Returns True if the TTS engine is initialized and ready."""
        pass

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[str] = None
    ) -> bytes:
        """
        Synthesizes text input into audio stream binary bytes.

        Returns:
            Raw audio binary data (e.g. MP3 / WAV).
        """
        pass
