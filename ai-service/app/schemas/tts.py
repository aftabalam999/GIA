from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field

class TTSModelState(str, Enum):
    UNINITIALIZED = "UNINITIALIZED"
    LOADING = "LOADING"
    READY = "READY"
    FAILED = "FAILED"

class TTSSynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Text string to synthesize into speech audio")
    voice: Optional[str] = Field("default", description="Voice model identifier")
    language: Optional[str] = Field("en", description="Target language code")

class TTSStatusResponse(BaseModel):
    state: TTSModelState
    model_name: str
    voice: str
    device: str
    is_ready: bool
    error: Optional[str] = None
