from enum import Enum
from pydantic import BaseModel, Field

class VADEventType(str, Enum):
    SILENCE = "SILENCE"
    VOICE_STARTED = "VOICE_STARTED"
    VOICE_ACTIVE = "VOICE_ACTIVE"
    VOICE_ENDED = "VOICE_ENDED"
    EXCESSIVE_SILENCE = "EXCESSIVE_SILENCE"
    INVALID_AUDIO = "INVALID_AUDIO"

class VADConfig(BaseModel):
    min_speech_duration_ms: float = Field(250.0, description="Minimum duration of speech in ms to trigger VOICE_STARTED")
    silence_threshold_db: float = Field(-45.0, description="RMS energy threshold in dB below which audio is classified as silence")
    end_of_speech_timeout_ms: float = Field(800.0, description="Duration of post-speech silence in ms to trigger VOICE_ENDED")
    min_audio_duration_ms: float = Field(100.0, description="Minimum frame chunk duration in ms")
    max_utterance_duration_ms: float = Field(30000.0, description="Maximum duration in ms of a single utterance segment")
    max_silence_timeout_ms: float = Field(10000.0, description="Duration of continuous silence in ms to trigger EXCESSIVE_SILENCE")

class VADResult(BaseModel):
    event: VADEventType = Field(..., description="VAD state machine event")
    is_speech: bool = Field(..., description="True if current frame contains active speech")
    rms_db: float = Field(..., description="RMS energy volume in dB")
    duration_ms: float = Field(..., description="Processed frame duration in milliseconds")
    utterance_completed: bool = Field(False, description="True if a full speech segment was completed")
    speech_duration_ms: float = Field(0.0, description="Total speech duration of the current utterance in ms")
