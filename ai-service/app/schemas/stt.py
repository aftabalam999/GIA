from enum import Enum
from pydantic import BaseModel, Field
from typing import List, Optional

class STTModelState(str, Enum):
    UNINITIALIZED = "UNINITIALIZED"
    LOADING = "LOADING"
    READY = "READY"
    FAILED = "FAILED"

class TranscriptionSegment(BaseModel):
    start: float = Field(..., description="Segment start time in seconds")
    end: float = Field(..., description="Segment end time in seconds")
    text: str = Field(..., description="Transcribed text for this segment")
    confidence: float = Field(1.0, ge=0.0, le=1.0, description="Confidence score")

class StructuredTranscriptionResult(BaseModel):
    text: str = Field(..., description="Full transcribed text")
    language: str = Field("en", description="Detected language code")
    confidence: float = Field(1.0, ge=0.0, le=1.0, description="Overall confidence score")
    duration: float = Field(..., description="Audio duration in seconds")
    segments: List[TranscriptionSegment] = Field(default_factory=list, description="Transcribed segments")
    processing_time: float = Field(..., description="Inference processing time in seconds")

class STTStatusResponse(BaseModel):
    state: STTModelState = Field(..., description="STT Model lifecycle state")
    model_name: str = Field(..., description="STT model size/identifier")
    device: str = Field("cpu", description="Execution device (cpu / cuda)")
    compute_type: str = Field("int8", description="Quantization / compute type")
    is_ready: bool = Field(..., description="True if STT model is ready to serve requests")
    error: Optional[str] = Field(None, description="Initialization error message if state is FAILED")
