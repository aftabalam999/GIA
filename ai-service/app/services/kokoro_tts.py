import os
import io
import re
import time
import math
import asyncio
import logging
from pathlib import Path
from typing import Optional, Tuple, Dict, Any, List, Union
import numpy as np
import soundfile as sf
import torch

from app.core.config import settings
from app.schemas.tts import (
    TTSModelState,
    TTSStatusResponse,
    TTSSynthesisResult
)
from app.services.base_tts import TextToSpeechService
from app.core.exceptions import (
    ModelNotReadyException,
    SynthesisException,
    SynthesisTimeoutException,
    AudioProcessingException,
    AIServiceException
)

logger = logging.getLogger("ai_service.kokoro_tts")

KOKORO_SAMPLE_RATE = 24000
DEVANAGARI_PATTERN = re.compile(r"[\u0900-\u097F]")


class KokoroTTSEngine:
    """
    Dedicated local Text-to-Speech (TTS) engine wrapping Kokoro v1.0.
    - Loads local PyTorch weights and config without internet access.
    - Leverages Apple Silicon Metal Performance Shaders (MPS) with CPU fallback.
    - Supports multilingual synthesis: American English ('af_heart') and Hindi ('hf_alpha').
    - Performs in-memory 24,000 Hz 16-bit mono WAV synthesis with zero disk writes.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        config_path: Optional[str] = None,
        voices_dir: Optional[str] = None,
        device: Optional[str] = None
    ):
        self.model_path = model_path or getattr(settings, "TTS_MODEL_PATH", "models/TTS/kokoro-v1_0.pth")
        self.config_path = config_path or getattr(settings, "TTS_CONFIG_PATH", "models/TTS/config.json")
        self.voices_dir = voices_dir or getattr(settings, "TTS_VOICES_DIR", "models/TTS/voices")
        self.requested_device = device or getattr(settings, "TTS_DEVICE", "auto")

        self.device: str = "cpu"
        self._model = None
        self._voices: Dict[str, torch.Tensor] = {}
        self._pipelines: Dict[str, Any] = {}
        self._resolved_model_path: Optional[Path] = None
        self._resolved_config_path: Optional[Path] = None
        self._resolved_voices_dir: Optional[Path] = None
        self._ready: bool = False
        self._init_error: Optional[str] = None

    def _resolve_candidate_path(self, target_rel_path: str) -> Optional[Path]:
        """Resolves a file or directory across workspace and repo root candidates."""
        candidates = [
            Path(target_rel_path),
            Path("..") / target_rel_path,
            Path(__file__).resolve().parent.parent.parent.parent / target_rel_path,
            Path(__file__).resolve().parent.parent.parent / target_rel_path,
        ]
        for cand in candidates:
            if cand.exists():
                return cand.resolve()
        return None

    def _resolve_paths(self) -> None:
        """Locates model weights, configuration, and voice vectors on disk."""
        self._resolved_model_path = self._resolve_candidate_path(self.model_path)
        if not self._resolved_model_path or not self._resolved_model_path.is_file():
            raise ModelNotReadyException(f"Kokoro model weights not found at '{self.model_path}'")

        self._resolved_config_path = self._resolve_candidate_path(self.config_path)
        if not self._resolved_config_path or not self._resolved_config_path.is_file():
            raise ModelNotReadyException(f"Kokoro config not found at '{self.config_path}'")

        self._resolved_voices_dir = self._resolve_candidate_path(self.voices_dir)
        if not self._resolved_voices_dir or not self._resolved_voices_dir.is_dir():
            raise ModelNotReadyException(f"Kokoro voices directory not found at '{self.voices_dir}'")

    def initialize(self) -> None:
        """Loads Kokoro model once into memory, configures MPS/CPU device, and preloads voices."""
        if self._ready and self._model is not None:
            return

        try:
            from kokoro import KModel, KPipeline
        except ImportError as e:
            err_msg = f"Kokoro library not installed: {e}"
            logger.error(err_msg)
            self._init_error = err_msg
            self._ready = False
            raise ModelNotReadyException(err_msg)

        self._resolve_paths()

        # Device selection: MPS if available and requested, otherwise CPU
        target_device = "cpu"
        if self.requested_device.lower() in ["auto", "mps", "gpu"]:
            if torch.backends.mps.is_available():
                target_device = "mps"
                logger.info("Apple Silicon Metal Performance Shaders (MPS) is available.")
            else:
                logger.info("MPS unavailable; defaulting Kokoro TTS to CPU execution.")
        else:
            target_device = "cpu"

        logger.info(
            f"Loading Kokoro TTS model from '{self._resolved_model_path}' "
            f"on device '{target_device}'..."
        )

        try:
            # Load KModel with local config and weights
            kmodel = KModel(
                config=str(self._resolved_config_path),
                model=str(self._resolved_model_path),
                repo_id="hexgrad/Kokoro-82M"
            ).eval()

            # Attempt moving model to target device
            if target_device == "mps":
                try:
                    kmodel = kmodel.to("mps")
                    self.device = "mps"
                except Exception as mps_err:
                    logger.warning(f"Failed to move Kokoro model to MPS ({mps_err}); falling back to CPU.")
                    kmodel = kmodel.to("cpu")
                    self.device = "cpu"
            else:
                kmodel = kmodel.to("cpu")
                self.device = "cpu"

            self._model = kmodel

            # Preload local voice tensors without network access
            self._load_local_voices()

            # Pre-initialize pipelines for English ('a') and Hindi ('h') sharing the single loaded KModel
            self._pipelines["a"] = KPipeline(
                lang_code="a",
                model=self._model,
                device=self.device,
                repo_id="hexgrad/Kokoro-82M"
            )
            self._pipelines["h"] = KPipeline(
                lang_code="h",
                model=self._model,
                device=self.device,
                repo_id="hexgrad/Kokoro-82M"
            )

            self._ready = True
            self._init_error = None
            logger.info(f"Kokoro TTS Engine successfully initialized and READY on {self.device}.")

        except Exception as e:
            logger.error(f"Failed to initialize Kokoro TTS engine: {e}", exc_info=True)
            self._init_error = str(e)
            self._ready = False
            self._model = None
            raise ModelNotReadyException(f"Failed to initialize Kokoro TTS engine: {str(e)}")

    def _load_local_voices(self) -> None:
        """Loads pre-downloaded voice tensor vectors strictly from local disk."""
        assert self._resolved_voices_dir is not None

        voice_mappings = {
            "af_heart": self._resolved_voices_dir / "af_heart.pt",
            "hf_alpha": self._resolved_voices_dir / "hf_alpha.pt",
        }

        for voice_key, voice_file in voice_mappings.items():
            if voice_file.is_file():
                try:
                    tensor = torch.load(voice_file, weights_only=True)
                    self._voices[voice_key] = tensor
                    logger.debug(f"Preloaded local voice '{voice_key}' from '{voice_file}' (shape: {tensor.shape})")
                except Exception as e:
                    logger.warning(f"Could not load voice vector '{voice_key}': {e}")
            else:
                logger.warning(f"Voice file not found for '{voice_key}' at '{voice_file}'")

    def is_ready(self) -> bool:
        return self._ready and self._model is not None

    def shutdown(self) -> None:
        """Releases PyTorch weights and voice vectors from memory."""
        self._model = None
        self._voices.clear()
        self._pipelines.clear()
        self._ready = False
        self._init_error = None
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        logger.info("Kokoro TTS Engine shut down and resources freed.")

    def detect_language(self, text: str) -> str:
        """Detects whether text is Hindi (Devanagari Unicode) or English."""
        if DEVANAGARI_PATTERN.search(text):
            return "hi"
        return "en"

    def resolve_voice_and_pipeline(
        self,
        text: str,
        language: Optional[str] = None,
        voice: Optional[str] = None
    ) -> Tuple[Any, torch.Tensor, str, str]:
        """
        Resolves the appropriate language pipeline, voice tensor, and normalized names.
        Returns:
            Tuple[pipeline, voice_tensor, resolved_language, resolved_voice_name]
        """
        # 1. Resolve Language
        lang = (language or "").strip().lower()
        if not lang or lang == "auto":
            lang = self.detect_language(text)
        elif lang in ["hi", "h", "hin", "hindi"]:
            lang = "hi"
        else:
            lang = "en"

        # 2. Select pipeline
        pipeline_code = "h" if lang == "hi" else "a"
        pipeline = self._pipelines.get(pipeline_code)
        if pipeline is None:
            from kokoro import KPipeline
            pipeline = KPipeline(
                lang_code=pipeline_code,
                model=self._model,
                device=self.device,
                repo_id="hexgrad/Kokoro-82M"
            )
            self._pipelines[pipeline_code] = pipeline

        # 3. Resolve Voice
        selected_voice_name = (voice or "").strip().lower()
        if not selected_voice_name or selected_voice_name in ["default", "auto"]:
            selected_voice_name = "hf_alpha" if lang == "hi" else "af_heart"

        # Clean voice key
        voice_key = selected_voice_name
        if voice_key.endswith(".pt"):
            voice_key = Path(voice_key).stem

        # Fetch preloaded voice tensor
        voice_tensor = self._voices.get(voice_key)
        if voice_tensor is None:
            # Check if voice is in voices directory
            if self._resolved_voices_dir:
                cand_file = self._resolved_voices_dir / f"{voice_key}.pt"
                if cand_file.is_file():
                    voice_tensor = torch.load(cand_file, weights_only=True)
                    self._voices[voice_key] = voice_tensor

        # Fallback to default for language if requested voice not found
        if voice_tensor is None:
            fallback_key = "hf_alpha" if lang == "hi" else "af_heart"
            logger.warning(
                f"Requested voice '{selected_voice_name}' not available. "
                f"Falling back to '{fallback_key}'."
            )
            voice_tensor = self._voices.get(fallback_key)
            selected_voice_name = fallback_key

        if voice_tensor is None:
            raise SynthesisException("No valid voice vector available for synthesis.")

        return pipeline, voice_tensor, lang, selected_voice_name

    def synthesize(
        self,
        text: str,
        language: Optional[str] = None,
        voice: Optional[str] = None,
        speed: float = 1.0
    ) -> Tuple[bytes, TTSSynthesisResult]:
        """
        Synthesizes text into 24 kHz 16-bit Mono WAV audio in-memory.
        Returns:
            Tuple[wav_bytes, TTSSynthesisResult]
        """
        if not self.is_ready():
            raise ModelNotReadyException(f"Kokoro TTS is not ready: {self._init_error or 'Not initialized'}")

        clean_text = (text or "").strip()
        if not clean_text:
            raise AIServiceException("Text payload cannot be empty", status_code=400)

        # Speed normalization & clamping (0.5 to 2.5)
        safe_speed = max(0.25, min(3.0, float(speed)))

        pipeline, voice_tensor, resolved_lang, resolved_voice = self.resolve_voice_and_pipeline(
            text=clean_text,
            language=language,
            voice=voice
        )

        try:
            audio_chunks: List[np.ndarray] = []
            phoneme_parts: List[str] = []

            # Execute synthesis generator
            for result in pipeline(clean_text, voice=voice_tensor, speed=safe_speed):
                if result.audio is not None:
                    audio_np = result.audio.cpu().numpy()
                    audio_chunks.append(audio_np)
                if hasattr(result, "phonemes") and result.phonemes:
                    phoneme_parts.append(result.phonemes)

            if not audio_chunks:
                raise SynthesisException("Kokoro synthesis generated 0 audio samples.")

            combined_audio = np.concatenate(audio_chunks)

            # In-memory WAV encoding
            wav_io = io.BytesIO()
            sf.write(wav_io, combined_audio, KOKORO_SAMPLE_RATE, format="WAV", subtype="PCM_16")
            wav_bytes = wav_io.getvalue()

            duration_sec = round(len(combined_audio) / float(KOKORO_SAMPLE_RATE), 3)
            all_phonemes = " ".join(phoneme_parts).strip() if phoneme_parts else None

            meta = TTSSynthesisResult(
                duration_seconds=duration_sec,
                sample_rate=KOKORO_SAMPLE_RATE,
                language=resolved_lang,
                voice=resolved_voice,
                speed=safe_speed,
                device=self.device,
                text=clean_text,
                phonemes=all_phonemes
            )

            return wav_bytes, meta

        except Exception as e:
            # If failed on MPS, attempt automatic CPU fallback
            if self.device == "mps":
                logger.warning(f"MPS inference failed ({e}); attempting automatic CPU fallback...")
                try:
                    self._model = self._model.to("cpu")
                    self.device = "cpu"
                    self._pipelines.clear()
                    return self.synthesize(text=clean_text, language=language, voice=voice, speed=speed)
                except Exception as cpu_e:
                    logger.error(f"CPU fallback also failed: {cpu_e}", exc_info=True)

            logger.error(f"Kokoro synthesis failed: {e}", exc_info=True)
            raise SynthesisException(f"Kokoro speech synthesis failed: {str(e)}")


class KokoroTTSService(TextToSpeechService):
    """
    Asynchronous Thread-Safe Service wrapping the KokoroTTSEngine.
    Conforms to the GIA AI Service TextToSpeechService interface.
    """

    def __init__(
        self,
        model_name: Optional[str] = None,
        voice: Optional[str] = None,
        device: Optional[str] = None
    ):
        self.model_name = model_name or getattr(settings, "TTS_MODEL_NAME", "kokoro-v1_0")
        self.voice = voice or getattr(settings, "TTS_VOICE", "af_heart")
        self.device = device or getattr(settings, "TTS_DEVICE", "auto")
        self.sample_rate = KOKORO_SAMPLE_RATE
        self.max_text_length = getattr(settings, "TTS_MAX_TEXT_LENGTH", 2000)
        self.timeout_seconds = getattr(settings, "TTS_TIMEOUT_SECONDS", 30.0)

        self._state: TTSModelState = TTSModelState.UNINITIALIZED
        self._engine = KokoroTTSEngine(device=self.device)
        self._init_error: Optional[str] = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> TTSModelState:
        return self._state

    def is_ready(self) -> bool:
        return self._state == TTSModelState.READY and self._engine.is_ready()

    def get_status(self) -> TTSStatusResponse:
        return TTSStatusResponse(
            state=self._state,
            model_name=self.model_name,
            voice=self.voice,
            device=self._engine.device if self.is_ready() else self.device,
            sample_rate=self.sample_rate,
            is_ready=self.is_ready(),
            error=self._init_error
        )

    async def initialize(self) -> None:
        """Initializes Kokoro TTS model weights into memory ONCE."""
        async with self._lock:
            if self.is_ready():
                return

            self._state = TTSModelState.LOADING
            self._init_error = None
            logger.info("Initializing Kokoro TTS Service...")

            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._engine.initialize)
                self._state = TTSModelState.READY
                self.device = self._engine.device
                logger.info(f"Kokoro TTS Service READY on device '{self.device}'.")
            except Exception as e:
                logger.error(f"Failed to initialize Kokoro TTS Service: {e}")
                self._init_error = str(e)
                self._state = TTSModelState.FAILED
                raise

    async def shutdown(self) -> None:
        """Tears down Kokoro model resources."""
        async with self._lock:
            logger.info("Shutting down Kokoro TTS Service...")
            self._engine.shutdown()
            self._state = TTSModelState.UNINITIALIZED
            self._init_error = None

    async def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[Union[float, str]] = None,
        language: Optional[str] = None
    ) -> bytes:
        """Synthesizes text into 24 kHz WAV audio bytes with timeout protection."""
        wav_bytes, _ = await self.synthesize_with_metadata(
            text=text,
            voice=voice,
            speed=speed,
            language=language
        )
        return wav_bytes

    async def synthesize_with_metadata(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[Union[float, str]] = None,
        language: Optional[str] = None
    ) -> Tuple[bytes, TTSSynthesisResult]:
        """Synthesizes text into WAV audio bytes and returns structured telemetry metadata."""
        if not self.is_ready():
            raise ModelNotReadyException(
                f"Kokoro TTS engine is not ready (State: {self._state.value}). Error: {self._init_error or 'None'}"
            )

        if text is None or not str(text).strip():
            raise AIServiceException("Text payload cannot be empty", status_code=400)

        clean_text = str(text).strip()
        if len(clean_text) > self.max_text_length:
            raise AIServiceException(
                f"Text length ({len(clean_text)}) exceeds limit ({self.max_text_length})",
                status_code=400
            )

        # Parse speed
        parsed_speed = 1.0
        if speed is not None:
            try:
                parsed_speed = float(speed)
            except (ValueError, TypeError):
                parsed_speed = 1.0

        loop = asyncio.get_running_loop()

        def _run_synth():
            return self._engine.synthesize(
                text=clean_text,
                language=language,
                voice=voice,
                speed=parsed_speed
            )

        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, _run_synth),
                timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError:
            logger.error(f"Kokoro TTS timed out after {self.timeout_seconds}s")
            raise SynthesisTimeoutException(f"TTS synthesis timed out after {self.timeout_seconds} seconds")
        except AIServiceException:
            raise
        except Exception as e:
            logger.error(f"Kokoro TTS execution failed: {e}", exc_info=True)
            raise SynthesisException(f"Kokoro speech synthesis failed: {str(e)}")

    async def synthesize_stream(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[Union[float, str]] = None,
        language: Optional[str] = None,
        chunk_size: int = 4096
    ):
        """Streams WAV bytes in small chunks for low-latency desktop playback."""
        wav_bytes = await self.synthesize(text=text, voice=voice, speed=speed, language=language)
        for i in range(0, len(wav_bytes), chunk_size):
            yield wav_bytes[i : i + chunk_size]
            await asyncio.sleep(0.001)


gia_kokoro_service = KokoroTTSService()

