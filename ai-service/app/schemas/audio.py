from pydantic import BaseModel, Field
from typing import Optional

class AudioMetadataSchema(BaseModel):
    sample_rate: int = Field(16000, description="Audio sampling rate in Hz")
    channels: int = Field(1, description="Number of audio channels")
    format: str = Field("pcm_s16le", description="Audio format identifier")
    duration_seconds: Optional[float] = Field(None, description="Duration in seconds")

class AudioAnalysisResponseSchema(BaseModel):
    valid: bool = Field(True, description="Indicates if audio meets GIA specification criteria")
    sample_rate: int = Field(16000, description="Normalized sample rate in Hz")
    channels: int = Field(1, description="Normalized channel count (Mono)")
    duration_seconds: float = Field(..., description="Audio duration in seconds")
    rms_db: float = Field(..., description="RMS volume level in dB")
    is_silent: bool = Field(..., description="True if audio volume is below silence threshold")
    size_bytes: int = Field(..., description="Normalized PCM payload size in bytes")

class TranscribeRequestSchema(BaseModel):
    language: Optional[str] = Field(None, description="ISO 639-1 language code hint")
    prompt: Optional[str] = Field(None, description="Contextual prompt to guide STT decoding")

class TranscribeResponseSchema(BaseModel):
    text: str = Field(..., description="Recognized speech text")
    confidence: float = Field(1.0, ge=0.0, le=1.0, description="Confidence score")
    language: str = Field("en", description="Detected language code")
    duration: float = Field(0.0, description="Processed audio duration in seconds")

class SynthesizeRequestSchema(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000, description="Text to render into audio")
    voice: Optional[str] = Field(None, description="Target voice name")
    speed: Optional[str] = Field("+0%", description="Speech rate adjustment")

class SynthesizeResponseSchema(BaseModel):
    audio_format: str = Field("mp3", description="Generated audio format")
    content_type: str = Field("audio/mpeg", description="MIME type for stream response")
