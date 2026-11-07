import os
import logging
from pathlib import Path
from typing import Optional, Tuple, List
import numpy as np
import onnxruntime as ort

from app.core.config import settings
from app.core.exceptions import AudioProcessingException

logger = logging.getLogger("ai_service.silero_vad")

# Silero VAD constants for 16 kHz audio
SILERO_SAMPLE_RATE = 16000
SILERO_WINDOW_SIZE = 512  # 512 samples = 32ms at 16kHz
SILERO_STATE_SHAPE = (2, 1, 128)

class SileroVADEngine:
    """
    Stateful deep-learning Voice Activity Detection engine wrapping Silero VAD v4/v5 ONNX model.
    Runs locally on Apple Silicon / macOS arm64 using ONNX Runtime CPU execution provider.
    Maintains recurrent LSTM hidden states across consecutive 512-sample (32ms) audio frames.
    """

    def __init__(self, model_path: Optional[str] = None):
        self.model_path = model_path or getattr(settings, "VAD_MODEL_PATH", "models/silero-vad/model.onnx")
        self._session: Optional[ort.InferenceSession] = None
        self._state: np.ndarray = np.zeros(SILERO_STATE_SHAPE, dtype=np.float32)
        self._sr: np.ndarray = np.array(SILERO_SAMPLE_RATE, dtype=np.int64)
        self._leftover: np.ndarray = np.array([], dtype=np.float32)
        self._ready: bool = False
        self._resolved_path: Optional[Path] = None

        self.initialize()

    def _resolve_model_path(self) -> Optional[Path]:
        """Resolves local model file path checking multiple workspace locations."""
        candidates = []
        if self.model_path:
            candidates.append(Path(self.model_path))

        # Check relative to working directory
        candidates.append(Path("models/silero-vad/model.onnx"))
        candidates.append(Path("../models/silero-vad/model.onnx"))

        # Check relative to this source file
        base_dir = Path(__file__).resolve().parent.parent.parent.parent
        candidates.append(base_dir / "models" / "silero-vad" / "model.onnx")

        # Check ai-service root
        ai_dir = Path(__file__).resolve().parent.parent.parent
        candidates.append(ai_dir / "models" / "silero-vad" / "model.onnx")

        for cand in candidates:
            if cand.is_file():
                return cand.resolve()
        return None

    def initialize(self) -> None:
        """Initializes ONNX Runtime session and allocates recurrent state buffer."""
        resolved = self._resolve_model_path()
        if not resolved or not resolved.is_file():
            logger.warning(
                f"Silero VAD ONNX model not found at '{self.model_path}'. "
                "Silero deep-learning VAD will be unavailable (will fallback to energy VAD)."
            )
            self._ready = False
            return

        self._resolved_path = resolved
        try:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            opts.log_severity_level = 3  # Errors only

            self._session = ort.InferenceSession(
                str(resolved),
                sess_options=opts,
                providers=["CPUExecutionProvider"]
            )
            self.reset_state()
            self._ready = True
            logger.info(f"Loaded Silero VAD ONNX model from '{resolved}' successfully.")
        except Exception as e:
            logger.error(f"Failed to initialize Silero VAD ONNX session: {e}")
            self._session = None
            self._ready = False

    def is_ready(self) -> bool:
        """Returns True if the ONNX session is loaded and ready for inference."""
        return self._ready and self._session is not None

    def reset_state(self) -> None:
        """Resets the recurrent LSTM hidden state and leftover sample buffers."""
        self._state = np.zeros(SILERO_STATE_SHAPE, dtype=np.float32)
        self._leftover = np.array([], dtype=np.float32)

    def get_state(self) -> np.ndarray:
        """Returns a copy of the current recurrent hidden state tensor."""
        return self._state.copy()

    def set_state(self, state: np.ndarray) -> None:
        """Directly injects recurrent state tensor (validates shape [2, 1, 128])."""
        if state.shape != SILERO_STATE_SHAPE:
            raise AudioProcessingException(
                f"Invalid state shape {state.shape}. Expected {SILERO_STATE_SHAPE}."
            )
        self._state = state.astype(np.float32).copy()

    def process_frame(self, frame: np.ndarray, sample_rate: int = SILERO_SAMPLE_RATE) -> float:
        """
        Executes one forward pass of Silero VAD on exactly 512 float32 samples.
        Updates internal recurrent LSTM state.
        
        Returns:
            Speech probability between 0.0 and 1.0.
        """
        if not self.is_ready():
            raise AudioProcessingException("Silero VAD model is not initialized.")

        if sample_rate != SILERO_SAMPLE_RATE:
            raise AudioProcessingException(
                f"Silero VAD requires sample rate of {SILERO_SAMPLE_RATE} Hz, got {sample_rate} Hz."
            )

        if len(frame) != SILERO_WINDOW_SIZE:
            raise AudioProcessingException(
                f"Silero VAD frame must be exactly {SILERO_WINDOW_SIZE} samples, got {len(frame)}."
            )

        # Ensure float32 shape [1, 512]
        x = frame.astype(np.float32).reshape(1, SILERO_WINDOW_SIZE)

        try:
            inputs = {
                "input": x,
                "state": self._state,
                "sr": self._sr
            }
            output, new_state = self._session.run(None, inputs)
            self._state = new_state
            prob = float(output[0][0])
            return prob
        except Exception as e:
            logger.error(f"Silero VAD forward pass failed: {e}")
            raise AudioProcessingException(f"Silero VAD inference error: {str(e)}")

    def process_audio_chunk(
        self,
        audio_samples: np.ndarray,
        sample_rate: int = SILERO_SAMPLE_RATE
    ) -> Tuple[float, List[float], int]:
        """
        Processes an arbitrary-length 1D float32 audio chunk at 16 kHz.
        Slices audio into sequential 512-sample frames, tracks recurrent state,
        and saves leftover samples (< 512) for the next call.

        Returns:
            Tuple of (max_speech_prob, list_of_frame_probs, total_frames_processed)
        """
        if sample_rate <= 0 or sample_rate != SILERO_SAMPLE_RATE:
            raise AudioProcessingException(
                f"Silero VAD requires sample rate {SILERO_SAMPLE_RATE} Hz, got {sample_rate} Hz."
            )

        if audio_samples.ndim > 1:
            audio_samples = audio_samples.flatten()

        samples_f32 = audio_samples.astype(np.float32)

        # Concatenate leftover samples from prior chunk
        if len(self._leftover) > 0:
            total_samples = np.concatenate([self._leftover, samples_f32])
        else:
            total_samples = samples_f32

        n_samples = len(total_samples)
        frame_probs: List[float] = []
        end_idx = 0

        for i in range(0, n_samples - SILERO_WINDOW_SIZE + 1, SILERO_WINDOW_SIZE):
            frame = total_samples[i : i + SILERO_WINDOW_SIZE]
            prob = self.process_frame(frame, sample_rate)
            frame_probs.append(prob)
            end_idx = i + SILERO_WINDOW_SIZE

        # Buffer leftover samples for the subsequent chunk
        if end_idx < n_samples:
            self._leftover = total_samples[end_idx:].copy()
        else:
            self._leftover = np.array([], dtype=np.float32)

        max_prob = max(frame_probs) if frame_probs else 0.0
        return max_prob, frame_probs, len(frame_probs)

