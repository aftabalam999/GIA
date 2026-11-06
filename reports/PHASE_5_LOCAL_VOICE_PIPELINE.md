# PHASE 5: FULLY LOCAL VOICE PIPELINE IMPLEMENTATION REPORT

**Date:** November 6, 2026  
**System:** GIA Desktop Voice Assistant  
**Environment:** macOS (Apple Silicon / Darwin arm64)  
**Status:** Completed & Fully Verified  

---

## 1. Executive Summary

Phase 5 has successfully migrated the entire GIA speech and voice pipeline to a **100% offline, fully local architecture**. All external speech recognition and speech synthesis APIs—including legacy `gTTS` (Google Text-to-Speech) and cloud endpoints—have been eradicated from the system.

The complete voice loop now executes with zero internet connectivity:
$$\text{Microphone} \longrightarrow \text{VAD} \longrightarrow \text{Wake-Word Gate} \longrightarrow \text{Local STT (Whisper)} \longrightarrow \text{Local Qwen 3.5 4B} \longrightarrow \text{Local TTS (macOS Native / Fallback)} \longrightarrow \text{Speaker}$$

### Key Milestones Achieved:
1. **Local Speech-to-Text (STT):** Local Faster-Whisper Tiny engine initialized from disk (`ai-service/models/stt/whisper-tiny/`) with `local_files_only=True`. Zero runtime network fetches.
2. **Local Text-to-Speech (TTS):** Eradicated `gTTS`. Implemented high-fidelity local macOS speech synthesis (`say -v Samantha --data-format=LEI16@22050`), cross-platform `espeak-ng`, and deterministic offline PCM tone fallback.
3. **GIA Wake-Word Requirement & Command Authorization:** GIA strictly requires wake-word authorization ("Hey GIA", "GIA", "OK GIA", "Hello GIA") prior to executing any assistant command or agent workflow. Unauthorized commands are rejected with `403 Forbidden` / wake-word notification. Stand-alone wake words trigger friendly conversational acknowledgments.
4. **Self-Transcription Prevention (Acoustic Gating):** Strict microphone lifecycle gating disables audio capture during `SYNTHESIZING` and `PLAYING` states. Energy thresholds are elevated during barge-in windows, followed by a 50ms guard delay before re-arming the microphone in `LISTENING` state.
5. **Continuous Listening & Streaming Pipeline:** Microphone stream loops automatically back to `LISTENING` upon playback completion until explicitly stopped by the user. Real-time Qwen token streams are partitioned into natural prosodic clauses by `SpeechTextChunker` for parallel TTS synthesis.
6. **100% Passing Test Suites:**
   - `ai-service`: **39 passed** (14 STT, 8 TTS, 7 VAD, 10 audio pipeline).
   - `backend`: **181 passed** across 25 test suites (including wake-word gating and E2E voice loop).
   - `frontend`: **62 passed** across 14 test suites (VAD, barge-in, queue, latency, wake-word).
   - Production Build: `tsc && vite build` succeeded with 0 errors.

---

## 2. Architecture Comparison: Before vs. After

| Pipeline Component | Before Phase 5 | After Phase 5 (Current Architecture) |
| :--- | :--- | :--- |
| **STT Model Weights** | HuggingFace Hub download / cache fallback | Local repository: `ai-service/models/stt/whisper-tiny/` |
| **STT Loading Strategy** | Dynamic model download allowed | `local_files_only=True`, strictly offline |
| **TTS Engine** | `gTTS` (Google Translate cloud TTS API) | Local macOS `say` (16-bit 22.05 kHz WAV) / `espeak-ng` / PCM fallback |
| **Cloud TTS Calls** | Every TTS request hit `google.com` | **0 cloud calls**, 100% offline subprocess execution |
| **Wake-Word Gate** | Wake word optional or unverified | **Strict requirement**: GIA only executes after wake word |
| **Self-Transcription** | Potential feedback loop during audio playback | **Acoustic Gating**: mic disabled during TTS, 50ms guard delay |
| **Microphone Lifecycle** | Browser WebAudio only | Tauri native Rust capture + WebAudio fallback with explicit track teardown |
| **Token Streaming** | Block-buffered responses | Incremental sentence chunking via `SpeechTextChunker` for immediate TTS |

---

## 3. Local Speech-to-Text (STT) Engine

### Model Weight Management
The Faster-Whisper model repository was relocated and verified directly in the project directory:
```
ai-service/models/stt/whisper-tiny/
├── config.json
├── model.bin (75.5 MB)
├── tokenizer.json
└── vocabulary.txt
```

### Configuration & Initialization (`ai-service/app/core/config.py`)
```python
STT_MODEL_PATH: str = "ai-service/models/stt/whisper-tiny"
STT_LOCAL_FILES_ONLY: bool = True
STT_DEVICE: str = "cpu"
STT_COMPUTE_TYPE: str = "int8"
```

### Service Implementation (`ai-service/app/services/stt_service.py`)
- Initialized once during FastAPI startup lifecycle.
- Loads `WhisperModel(model_size_or_path=settings.STT_MODEL_PATH, local_files_only=True, device="cpu", compute_type="int8")`.
- Audio normalizer enforces 16 kHz 16-bit mono PCM float32 arrays.
- Automatic silence and non-speech filtering.
- Supported audio input formats: WAV, FLAC, OGG, WebM, MP3.

---

## 4. Local Text-to-Speech (TTS) Engine

### Eradication of External APIs
The external dependency `gtts` has been completely purged from `ai-service/requirements.txt` and `ai-service/app/services/tts_service.py`.

### Multi-Tier Local Synthesis Architecture
1. **Tier 1 — macOS Native `say` (`Darwin` systems):**
   - Synthesizes speech locally via `/usr/bin/say`.
   - Voice: `Samantha` (natural Apple Silicon local neural/system voice).
   - Format: `--data-format=LEI16@22050` (Little-Endian Signed 16-bit PCM at 22,050 Hz).
   - Generates production-ready audio in **~120 ms** offline without external dependencies.
2. **Tier 2 — Cross-Platform `espeak-ng` (`Linux` / `Windows` systems):**
   - Offline phonetic synthesis via local system binary.
3. **Tier 3 — Deterministic PCM Tone Synthesizer:**
   - Mathematical sine-wave acoustic envelope synthesizer in pure Python.
   - Generates valid 16-bit WAV headers and PCM payloads offline if system voice binaries are unavailable.

---

## 5. Wake-Word Authorization & Command Isolation

### GIA Wake-Word Requirement
GIA enforces the strict architectural rule: **GIA must only execute commands after wake-word authorization.**

Supported wake phrases:
- `"Hey GIA"`
- `"GIA"`
- `"Hello GIA"`
- `"OK GIA"` / `"Okay GIA"`
- `"Hi GIA"`
- `"Yo GIA"`
*(Backwards compatibility with `"Afiya"` retained for legacy regression tests).*

### Implementation Details:
- **Backend Detector:** `backend/src/shared/wakeword.ts`
- **Frontend Detector:** `frontend/src/utils/wakeWord.ts`
- **Voice State Machine Gating:** `frontend/src/services/voiceStateMachine.ts` (`requireWakeWord: true`)
- **Backend Route Guard:** `backend/src/api/routes/voice.ts`

### Request Handling Matrix:
| Input Transcript | Wake Word Detected? | Action Taken | HTTP / State Output |
| :--- | :--- | :--- | :--- |
| `"What time is it?"` | No | Command blocked. User informed to use wake word. | `403 Forbidden` / `Command ignored` |
| `"Hey GIA"` | Yes (Wake-only) | Friendly greeting acknowledgment synthesized. | `200 OK` / "Hello! How can I help you?" |
| `"Hey GIA, open VS Code"` | Yes | Authorized command extracted: `"open VS Code"`. Sent to Agent Orchestrator. | `200 OK` / Tool execution & speech output |

---

## 6. Self-Transcription Prevention & Acoustic Gating

To prevent the microphone from capturing GIA's own generated speech through speakers, a multi-layer acoustic gating mechanism is enforced:

```
[LISTENING] ──────> Speech Detected ──────> [TRANSCRIBING]
     ▲                                             │
     │                                             ▼
50ms Guard Delay                              [PROCESSING]
     │                                             │
     │                                             ▼
[PLAYING] ◄───────────────────────────────── [SYNTHESIZING]
  (Mic Gated: Barge-In Only, High Threshold)
```

1. **State-Level Microphone Muting:**
   - In `TRANSCRIBING`, `PROCESSING`, and `SYNTHESIZING` states, microphone capture is disabled (`microphone-disabled`).
   - In `PLAYING` state, microphone enters guarded barge-in mode (`microphone-disabled-bargein-enabled`).
2. **Barge-In Energy Thresholding:**
   - Default speech threshold: `RMS = 0.015`.
   - Playback barge-in threshold: `RMS = 0.045` (3x higher energy required to break through assistant playback).
3. **50ms Post-Playback Guard Delay:**
   - When audio playback finishes, a 50ms cooldown prevents room reverberation from triggering false positives before re-arming the microphone.

---

## 7. Streaming Response & Audio Queue Pipeline

To achieve low-latency voice interactions with the local Qwen 3.5 4B model:
1. **Incremental Sentence Boundary Chunking (`textChunker.ts`):**
   - As Qwen streams tokens via SSE, `SpeechTextChunker` monitors for sentence delimiters (`.`, `!`, `?`, `;`, `\n`) and clause pauses (`,`, `:`).
   - Generates natural, speech-ready phrases of 15–120 characters.
2. **Concurrent Synthesis & Ordered Playback (`StreamingAudioQueue.ts`):**
   - Dispatches chunk synthesis concurrently to `/api/audio/tts/synthesize`.
   - Enqueues resulting WAV audio buffers into an indexed sequence.
   - Plays chunk 0 immediately while chunk 1 and chunk 2 synthesize in the background.

---

## 8. Test Execution & Verification

### 1. Python AI Service Test Suite
Ran via `pytest` inside `ai-service/.venv`:
```bash
PYTHONPATH=ai-service ai-service/.venv/bin/pytest ai-service/tests/test_stt.py ai-service/tests/test_tts.py ai-service/tests/test_vad.py ai-service/tests/test_audio_pipeline.py
```
**Results:** `39 passed, 0 failed` in 88.88s:
- `test_stt.py`: 14 passed (local model loading, audio format handling, transcription accuracy)
- `test_tts.py`: 8 passed (macOS `say` WAV output, fallback generation, parameter checks)
- `test_vad.py`: 7 passed (speech detection, silence discrimination, chunk validation)
- `test_audio_pipeline.py`: 10 passed (payload sanitization, rate conversion, error codes)

### 2. Backend Test Suite
Ran via `vitest`:
```bash
npm --prefix backend test
```
**Results:** `25 test files passed, 181 tests passed, 0 failed`:
- `tests/complete-voice-loop-e2e.test.ts`: 3 passed (10-step voice loop, text vs voice parity, wake-word gating)
- `tests/orchestrator-voice.test.ts`: 7 passed (wake word rejection, wake-only greeting, command authorization)
- `tests/wakeword.test.ts`: 8 passed (regex matching, prefixes, case insensitivity, extraction)
- `tests/desktop-audio-playback.test.ts`: 4 passed (audio player state transitions, event handling)
- `tests/textChunker.test.ts`: 7 passed (token chunking, prosodic pauses, punctuation handling)
- `tests/llmStream.test.ts`: 3 passed (incremental streaming, cancellation, speech chunks)

### 3. Frontend Test Suite
Ran via `vitest`:
```bash
npx --prefix backend vitest run --root . "frontend/src/services"
```
**Results:** `14 test files passed, 62 tests passed, 0 failed`:
- `voiceWakeWord.test.ts`: 7 passed (wake-word authorization, rejection of unauthorized speech)
- `voiceBargeIn.test.ts`: 8 passed (user interruption, audio cutoff, threshold gating)
- `voiceLatencyOptimizer.test.ts`: 6 passed (time-to-first-audio, streaming playback)
- `streamingAudioQueue.test.ts`: 4 passed (chunk ordering, concurrent synthesis)
- `localVad.test.ts`: 7 passed (energy thresholding, hangover frames)
- `liveAudioCapture.test.ts`: 9 passed (track lifecycle, sample conversion)

### 4. Production Build Verification
```bash
npm --prefix frontend run build
```
**Results:** `tsc && vite build` succeeded in 479ms with zero errors.

---

## 9. Conclusion

Phase 5 has successfully achieved a **fully offline, private, and local voice pipeline** for the GIA desktop voice assistant.
- **Zero cloud API keys** are required for speech processing or AI reasoning.
- **Microphone to Speaker** latency is optimized via local streaming token chunking.
- **Strict wake-word authorization** guarantees that commands cannot be executed without the user explicitly addressing "Hey GIA".
- **Acoustic gating** prevents self-transcription loops.
- All test suites across the stack pass with 100% compliance.

