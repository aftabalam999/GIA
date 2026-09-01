from abc import ABC, abstractmethod

class AudioProcessor(ABC):
    """
    Abstract interface for Audio Processing and Normalization operations.
    Handles format conversion, sample rate conversion, channel reduction, and peak normalization.
    """

    @abstractmethod
    async def process_audio(
        self,
        raw_bytes: bytes,
        target_sample_rate: int = 16000,
        target_channels: int = 1
    ) -> bytes:
        """
        Converts raw audio bytes into normalized PCM/WAV format.
        """
        pass

    @abstractmethod
    async def get_duration(self, raw_bytes: bytes) -> float:
        """
        Returns the duration of the audio in seconds.
        """
        pass
