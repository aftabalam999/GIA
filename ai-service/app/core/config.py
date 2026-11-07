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
    STT_MODEL_NAME: str = "small"
    STT_MODEL_PATH: str = "models/STT/ggml-small-q5_1.bin"
    STT_DEVICE: str = "auto"
    STT_COMPUTE_TYPE: str = "q5_1"
    STT_TIMEOUT_SECONDS: float = 30.0
    STT_LOCAL_FILES_ONLY: bool = True
    TTS_PROVIDER: str = "kokoro"
    TTS_MODEL_NAME: str = "kokoro-v1_0"
    TTS_MODEL_PATH: str = "models/TTS/kokoro-v1_0.pth"
    TTS_CONFIG_PATH: str = "models/TTS/config.json"
    TTS_VOICES_DIR: str = "models/TTS/voices"
    TTS_VOICE_EN: str = "af_heart"
    TTS_VOICE_HI: str = "hf_alpha"
    TTS_VOICE: str = "af_heart"
    TTS_DEVICE: str = "auto"
    TTS_SAMPLE_RATE: int = 24000
    TTS_MAX_TEXT_LENGTH: int = 2000
    TTS_TIMEOUT_SECONDS: float = 30.0
    VAD_PROVIDER: str = "silero"
    VAD_MODEL_PATH: str = "models/silero-vad/model.onnx"
    VAD_THRESHOLD: float = 0.5
    VAD_SAMPLE_RATE: int = 16000
    VAD_USE_SILERO: bool = True

    # Embedding Settings (Local Sentence Transformers)
    EMBEDDING_MODEL_NAME: str = "all-MiniLM-L6-v2"
    EMBEDDING_MODEL_PATH: str = "ai-service/models/embeddings/all-MiniLM-L6-v2"
    EMBEDDING_DIMENSION: int = 384
    EMBEDDING_DEVICE: str = "auto"
    EMBEDDING_LOCAL_FILES_ONLY: bool = True

    # LLM Settings (Local Qwen 3.5 4B)
    LLM_MODEL_NAME: str = "Qwen3.5-4B"
    LLM_MODEL_PATH: str = "ai-service/models/Qwen"
    LLM_DEVICE: str = "auto"
    LLM_DTYPE: str = "bfloat16"
    LLM_MAX_NEW_TOKENS: int = 1024
    LLM_TEMPERATURE: float = 0.7
    LLM_TOP_P: float = 0.9
    LLM_LOCAL_FILES_ONLY: bool = True
    LLM_SYSTEM_PROMPT: str = (
        "You are GIA (General Intelligent Assistant), a helpful, concise, and capable personal desktop AI assistant."
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings = Settings()
