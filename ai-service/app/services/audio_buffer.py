import io
import wave
from typing import Optional
from app.services.audio_processor import (
    GIAAudioProcessor,
    NormalizedAudio,
    CANONICAL_SAMPLE_RATE,
    CANONICAL_CHANNELS
)
from app.core.exceptions import AudioProcessingException

class AudioChunkBuffer:
    """
    Streaming Audio Chunk Buffer.
    Accumulates raw PCM bytes (or container chunks), monitors buffer length,
    and converts buffered audio into GIA NormalizedAudio format.
    """
    def __init__(self, processor: Optional[GIAAudioProcessor] = None):
        self.processor = processor or GIAAudioProcessor()
        self._buffer = bytearray()

    def append_chunk(self, chunk: bytes) -> None:
        if chunk:
            self._buffer.extend(chunk)

    def clear(self) -> None:
        self._buffer.clear()

    @property
    def buffered_bytes_length(self) -> int:
        return len(self._buffer)

    def get_normalized_audio(self) -> NormalizedAudio:
        if len(self._buffer) == 0:
            raise AudioProcessingException("Streaming audio buffer is empty")

        # Wrap accumulated PCM int16 chunks in a standard WAV header
        wav_io = io.BytesIO()
        with wave.open(wav_io, 'wb') as wav_file:
            wav_file.setnchannels(CANONICAL_CHANNELS)
            wav_file.setsampwidth(2)
            wav_file.setframerate(CANONICAL_SAMPLE_RATE)
            wav_file.writeframes(bytes(self._buffer))

        wav_bytes = wav_io.getvalue()
        return self.processor.decode_and_normalize(wav_bytes)
