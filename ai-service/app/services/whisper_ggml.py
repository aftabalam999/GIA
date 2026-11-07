import os
import time
import math
import logging
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any
import numpy as np
from pywhispercpp.model import Model

from app.core.config import settings
from app.schemas.stt import TranscriptionSegment
from app.core.exceptions import (
    ModelNotReadyException,
    TranscriptionException,
    AudioProcessingException
)

logger = logging.getLogger("ai_service.whisper_ggml")

WHISPER_SAMPLE_RATE = 16000

class WhisperGGMLEngine:
    """
    Dedicated local Whisper STT Engine wrapping whisper.cpp via pywhispercpp.
    Loads GGML quantized models (e.g. ggml-small-q5_1.bin), leverages Apple Silicon Metal GPU acceleration,
    supports offline multilingual transcription (English, Hindi, and mixed speech),
    and exposes structured transcription segments with timestamps and confidence scores.
    """

    def __init__(self, model_path: Optional[str] = None):
        self.model_path = model_path or getattr(settings, "STT_MODEL_PATH", "models/STT/ggml-small-q5_1.bin")
        self._model: Optional[Model] = None
        self._resolved_path: Optional[Path] = None
        self._ready: bool = False
        self._init_error: Optional[str] = None

    def _resolve_model_path(self) -> Optional[Path]:
        """Resolves local model file path checking multiple workspace locations."""
        candidates = []
        if self.model_path:
            candidates.append(Path(self.model_path))

        # Check relative to working directory
        candidates.append(Path("models/STT/ggml-small-q5_1.bin"))
        candidates.append(Path("../models/STT/ggml-small-q5_1.bin"))

        # Check relative to repo root
        base_dir = Path(__file__).resolve().parent.parent.parent.parent
        candidates.append(base_dir / "models" / "STT" / "ggml-small-q5_1.bin")

        # Check ai-service root
        ai_dir = Path(__file__).resolve().parent.parent.parent
        candidates.append(ai_dir / "models" / "STT" / "ggml-small-q5_1.bin")

        for cand in candidates:
            if cand.is_file():
                return cand.resolve()
        return None

    def initialize(self) -> None:
        """Loads the GGML model once into memory with Metal GPU acceleration enabled."""
        if self._ready and self._model is not None:
            return

        resolved = self._resolve_model_path()
        if not resolved or not resolved.is_file():
            err_msg = f"Whisper GGML model not found at '{self.model_path}'. Check model location."
            logger.error(err_msg)
            self._init_error = err_msg
            self._ready = False
            raise ModelNotReadyException(err_msg)

        self._resolved_path = resolved
        logger.info(f"Loading Whisper GGML model from '{resolved}' with Metal GPU acceleration...")
        try:
            self._model = Model(
                model=str(resolved),
                redirect_whispercpp_logs_to=None
            )
            self._ready = True
            self._init_error = None
            logger.info("Whisper GGML model loaded successfully and READY.")
        except Exception as e:
            self._init_error = str(e)
            self._ready = False
            self._model = None
            logger.error(f"Failed to load Whisper GGML model: {e}")
            raise ModelNotReadyException(f"Failed to load Whisper GGML model: {str(e)}")

    def is_ready(self) -> bool:
        """Returns True if the model is initialized and ready for inference."""
        return self._ready and self._model is not None

    def shutdown(self) -> None:
        """Releases Whisper model weights from memory."""
        self._model = None
        self._ready = False
        self._init_error = None
        logger.info("Whisper GGML model has been shut down.")

    def detect_language(self, audio_samples_f32: np.ndarray) -> Tuple[str, float]:
        """
        Detects spoken language from 16kHz float32 audio samples.
        Returns:
            Tuple[detected_language_code, confidence_probability]
        """
        if not self.is_ready():
            raise ModelNotReadyException("Whisper STT engine is not initialized.")

        try:
            lang_tuple, _ = self._model.auto_detect_language(audio_samples_f32)
            lang_code = str(lang_tuple[0])
            prob = float(lang_tuple[1])
            return lang_code, prob
        except Exception as e:
            logger.warning(f"Language auto-detection failed ({e}); defaulting to 'en'")
            return "en", 1.0

    def transcribe_samples(
        self,
        audio_samples_f32: np.ndarray,
        language: Optional[str] = None
    ) -> Tuple[str, str, float, List[TranscriptionSegment]]:
        """
        Transcribes a 1D float32 audio array at 16,000 Hz.
        Supports explicit language selection ('en', 'hi') or automatic language detection.
        
        Returns:
            Tuple[full_text, language, overall_confidence, segments_list]
        """
        if not self.is_ready():
            raise ModelNotReadyException("Whisper STT engine is not initialized.")

        if audio_samples_f32.ndim > 1:
            audio_samples_f32 = audio_samples_f32.flatten()

        if len(audio_samples_f32) == 0:
            raise AudioProcessingException("Audio sample array is empty")

        # Language resolution
        target_lang = language
        overall_conf = 1.0

        if not target_lang or target_lang.lower() == "auto":
            detected_lang, detected_prob = self.detect_language(audio_samples_f32)
            target_lang = detected_lang
            overall_conf = round(detected_prob, 2)
        else:
            target_lang = target_lang.lower().strip()

        try:
            raw_segments = self._model.transcribe(
                audio_samples_f32,
                language=target_lang,
                extract_probability=True
            )

            segments: List[TranscriptionSegment] = []
            text_parts: List[str] = []

            for seg in raw_segments:
                txt = seg.text.strip()
                # Filter Whisper internal blank token
                if txt == "[BLANK_AUDIO]":
                    continue

                # Centiseconds to seconds (whisper.cpp t0, t1 are in centiseconds)
                start_sec = round(float(seg.t0) / 100.0, 2)
                end_sec = round(float(seg.t1) / 100.0, 2)
                
                prob = getattr(seg, "probability", None)
                if prob is None or math.isnan(prob):
                    conf = overall_conf
                else:
                    conf = round(min(1.0, max(0.0, float(prob))), 2)

                if txt:
                    text_parts.append(txt)
                    segments.append(
                        TranscriptionSegment(
                            start=start_sec,
                            end=end_sec,
                            text=txt,
                            confidence=conf
                        )
                    )

            full_text = " ".join(text_parts).strip()
            return full_text, target_lang, overall_conf, segments

        except Exception as e:
            logger.error(f"Whisper transcription failed: {e}", exc_info=True)
            raise TranscriptionException(f"Whisper transcription failed: {str(e)}")

