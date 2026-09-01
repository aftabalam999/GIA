from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_NAME: str = "GIA AI Service"
    VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"

    HOST: str = "127.0.0.1"
    PORT: int = 8001
    CORS_ORIGINS: List[str] = ["http://127.0.0.1:3000", "http://localhost:3000"]

    # Security Boundaries
    INTERNAL_API_KEY: str = "gia_internal_secret_key_987654321"

    # Provider / Model Engine Identifiers (Configurable abstractions)
    STT_PROVIDER: str = "whisper"
    STT_MODEL_NAME: str = "tiny"
    STT_DEVICE: str = "cpu"
    STT_COMPUTE_TYPE: str = "int8"
    STT_TIMEOUT_SECONDS: float = 30.0
    TTS_PROVIDER: str = "neural"
    VAD_PROVIDER: str = "webrtc"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings = Settings()
