from abc import ABC, abstractmethod
from app.schemas.vad import VADResult, VADConfig

class VoiceActivityDetector(ABC):
    """
    Abstract interface for Voice Activity Detection (VAD).
    Determines whether a chunk of audio contains human speech frames versus silence/background noise,
    and manages the state machine for continuous voice detection.
    """

    @abstractmethod
    def is_ready(self) -> bool:
        """Returns True if VAD engine is ready."""
        pass

    @abstractmethod
    async def detect_speech(
        self,
        audio_chunk: bytes,
        sample_rate: int = 16000
    ) -> bool:
        """
        Evaluates an audio frame or buffer for voice activity.

        Returns:
            True if speech activity is detected, False otherwise.
        """
        pass

    @abstractmethod
    def process_chunk(
        self,
        audio_chunk: bytes,
        sample_rate: int = 16000
    ) -> VADResult:
        """
        Processes an incoming audio frame through the VAD state machine.

        Returns:
            VADResult indicating current event (VOICE_STARTED, VOICE_ACTIVE, VOICE_ENDED, etc.)
        """
        pass

    @abstractmethod
    def reset_state(self) -> None:
        """Resets the VAD state machine buffers without stopping the session."""
        pass
