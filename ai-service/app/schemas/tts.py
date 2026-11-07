from enum import Enum
from typing import Optional, Union
from pydantic import BaseModel, Field, field_validator

class TTSModelState(str, Enum):
    UNINITIALIZED = "UNINITIALIZED"
    LOADING = "LOADING"
    READY = "READY"
    FAILED = "FAILED"

class TTSSynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Text string to synthesize into speech audio")
    voice: Optional[str] = Field(None, description="Voice model identifier (e.g. 'af_heart', 'hf_alpha')")
    language: Optional[str] = Field(None, description="Target language code ('en', 'hi', or 'auto')")
    speed: Optional[Union[float, str]] = Field(1.0, description="Speech speed factor (default 1.0, range 0.25 to 3.0)")

    @field_validator("speed", mode="before")
    @classmethod
    def parse_speed(cls, v):
        if v is None:
            return 1.0
        if isinstance(v, str):
            try:
                v = float(v)
            except ValueError:
                return 1.0
        return float(v)

class TTSStatusResponse(BaseModel):
    state: TTSModelState
    model_name: str
    voice: str
    device: str
    sample_rate: int = 24000
    is_ready: bool
    error: Optional[str] = None

class TTSSynthesisResult(BaseModel):
    duration_seconds: float
    sample_rate: int = 24000
    language: str
    voice: str
    speed: float
    device: str
    text: str
    phonemes: Optional[str] = None
