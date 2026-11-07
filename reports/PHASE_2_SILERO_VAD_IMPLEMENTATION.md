# Phase 2: Silero VAD Engine Implementation Report

**Target Model:** `models/silero-vad/model.onnx` (2.1 MB)  
**Runtime:** ONNX Runtime (`CPUExecutionProvider`) on macOS Apple Silicon M1  
**Audio Standard:** 16,000 Hz, 16-bit Mono PCM / Float32 normalized  
**Date:** November 6, 2026  
**Status:** Phase 2 Complete — Verified with 100% Test Pass Rate  

---

## 1. Executive Summary

In Phase 2, the local deep-learning Voice Activity Detection (VAD) engine was implemented using the pre-downloaded Silero VAD v4/v5 ONNX model (`models/silero-vad/model.onnx`). The system replaces the previous naive RMS amplitude thresholding with a recurrent neural network (RNN/LSTM) that accurately distinguishes human speech from background noise, room reverberation, and speaker silence.

The implementation preserves the existing `VoiceActivityDetector` abstract interface, supports continuous audio streaming with recurrent state persistence, provides clean sample-rate and frame-window validation, and maintains backward compatibility via configurable energy fallback.

---

## 2. Architecture & Implementation Details

### 2.1 File Structure Changes
```
ai-service/app/
├── core/
│   └── config.py               # Added VAD_PROVIDER, VAD_MODEL_PATH, VAD_THRESHOLD, VAD_SAMPLE_RATE
├── schemas/
│   └── vad.py                  # Added speech_threshold, use_silero, sample_rate, speech_probability
├── services/
│   ├── silero_vad.py           # NEW: Dedicated SileroVADEngine wrapping ONNX Runtime
│   └── vad_service.py          # UPDATED: GIAVoiceActivityDetector integrating SileroVADEngine
└── tests/
    └── test_vad.py             # UPDATED: Comprehensive test suite for all 9 Phase 2 objectives
```

### 2.2 Model Specification & Recurrent State Handling
- **Input Tensor (`input`)**: `[batch_size, 512]` of `float32` audio samples normalized to `[-1.0, 1.0]`. At 16 kHz, each 512-sample frame represents exactly 32 ms.
- **Recurrent State (`state`)**: `[2, 1, 128]` of `float32`. This tensor carries the LSTM cell state and hidden state across consecutive frames.
- **Sample Rate (`sr`)**: Scalar `int64` tensor (`16000`).
- **Output (`output`)**: `[1, 1]` `float32`, extracting speech probability $p \in [0.0, 1.0]$.
- **Updated State (`stateN`)**: Output recurrent state tensor `[2, 1, 128]`, saved to `self._state` for the next frame.

### 2.3 Streaming Chunk Framing & Leftover Buffer
Microphone buffers often arrive in chunks that are not exact multiples of 512 samples (e.g., 100ms = 1,600 samples = $3 \times 512 + 64$).
`SileroVADEngine.process_audio_chunk()` handles this via an internal leftover buffer:
1. Concatenates any leftover samples from the previous chunk with the incoming chunk.
2. Iterates over all complete 512-sample frames, passing each through the ONNX model while updating recurrent state.
3. Buffers the remaining tail samples ($< 512$) to be prepended to the subsequent chunk.
4. Returns the chunk's maximum speech probability, frame probabilities, and processed frame count.

### 2.4 State Machine & Event Transitions
The VAD state machine (`GIAVoiceActivityDetector`) supports continuous streaming:
- **`SILENCE`**: Current frame probability $< \text{threshold}$ (or speech duration $< \text{min\_speech\_duration\_ms}$).
- **`VOICE_STARTED`**: Speech probability $\ge \text{threshold}$ continuously for $\ge \text{min\_speech\_duration\_ms}$ (default 250 ms).
- **`VOICE_ACTIVE`**: Ongoing speech utterance or trailing silence within $\text{end\_of\_speech\_timeout\_ms}$.
- **`VOICE_ENDED`**: Trailing silence exceeds $\text{end\_of\_speech\_timeout\_ms}$ (default 800 ms) or maximum utterance cap is reached. The completed speech buffer is packaged into a `NormalizedAudio` object for downstream STT ingestion.
- **`EXCESSIVE_SILENCE`**: Continuous silence exceeds $\text{max\_silence\_timeout\_ms}$ (default 10,000 ms).
- **`INVALID_AUDIO`**: Corrupted byte payload, odd byte lengths for 16-bit PCM, or unsupported sample rates.

---

## 3. Automated Test Verification Results

All 12 automated unit and integration tests in `ai-service/tests/test_vad.py` passed with 0 failures:

| Test Case | Objective Covered | Status | Result / Evidence |
| :--- | :--- | :--- | :--- |
| `test_silero_model_initialization` | Model loading & recurrent state shape verification | **PASSED** | ONNX session initialized, state shape `(2, 1, 128)`, norm `= 0.0` |
| `test_silero_silence_detection` | Silence classification & excessive silence timeout | **PASSED** | Silence $p < 0.1$, transitions to `EXCESSIVE_SILENCE` at 500ms |
| `test_silero_speech_detection` | Deep-learning speech detection | **PASSED** | Speech $p \ge 0.5$ (glottal harmonic series), `is_speech = True` |
| `test_speech_start_event` | Speech start gating with min duration | **PASSED** | Sub-threshold pending speech is `SILENCE`; transitions to `VOICE_STARTED` at 200ms |
| `test_speech_end_event` | Speech continuation & trailing silence termination | **PASSED** | Emits `VOICE_ACTIVE`, transitions to `VOICE_ENDED`, packages `NormalizedAudio` |
| `test_consecutive_audio_chunks_and_leftover` | Non-512 chunk slicing & leftover buffering | **PASSED** | 600 samples leaves 88 leftover; second 424 samples completes exact 512 frame |
| `test_model_state_reset` | Recurrent hidden state reset | **PASSED** | Post-speech state norm $> 0$; after `reset_state()`, norm strictly `= 0.0` |
| `test_invalid_audio_input` | Odd byte length & empty payloads | **PASSED** | Emits `VADEventType.INVALID_AUDIO` without unhandled crashes |
| `test_incorrect_sample_rate_handling` | Invalid / unsupported sample rates ($0, 44100$) | **PASSED** | Non-16kHz rates emit `VADEventType.INVALID_AUDIO` |
| `test_maximum_utterance_duration_cap` | Safety cap on continuous speech | **PASSED** | Forced `VOICE_ENDED` when utterance exceeds 400ms cap |
| `test_energy_fallback_when_silero_disabled` | Energy VAD backward compatibility | **PASSED** | When `use_silero=False`, operates seamlessly on RMS dB threshold |
| `test_vad_api_endpoints` | REST API routes (`GET /config`, `POST /config`, `POST /process`) | **PASSED** | Full HTTP endpoint roundtrips with `speech_probability` |

### Regression Testing Summary
- **AI Service Subsystem (`ai-service/tests/`)**: **75 / 75 tests passed** (Audio pipeline, STT, TTS, Embeddings, Reranker, LLM, VAD).
- **Backend Subsystem (`backend/tests/`)**: **277 / 277 tests passed** across all 30 test suites (Plan Execution Engine, Permission Manager, Voice State Machine, Security Audit).

---

## 4. Phase 2 Completion & Readiness for Phase 3

Phase 2 objectives have been fully met:
1. Silero ONNX model is loaded locally with zero cloud dependencies.
2. The recurrent state machine is fully operational and verified.
3. The interface is decoupled, clean, and ready for integration with Phase 3 (Whisper GGML Small STT Engine).
4. No source files outside the VAD subsystem were modified. Whisper STT, Kokoro TTS, Qwen LLM, permission managers, and React frontend remain completely intact.

**Execution stopped at Phase 2 per instructions. Awaiting user approval before proceeding to Phase 3.**

