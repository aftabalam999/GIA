# Phase 4 — Local Kokoro TTS Engine Implementation Report

## Executive Summary
The local Kokoro v1.0 Text-to-Speech (TTS) engine has been successfully implemented and verified for **GIA-AI** on macOS Apple Silicon M1. The implementation uses the pre-existing offline model weights, configuration, and voice tensors without requiring any external cloud APIs or online model downloads.

All audio is generated entirely in-memory at **24,000 Hz 16-bit Mono PCM WAV**, achieving hardware-accelerated synthesis via **PyTorch Metal Performance Shaders (MPS)** with transparent CPU fallback.

---

## 1. Exact Model Files & Paths Used

All models and voice profiles were loaded directly from their existing offline directories:
- **Weights**: `models/TTS/kokoro-v1_0.pth` (312 MB, SHA256 verified)
- **Configuration**: `models/TTS/config.json`
- **English Voice**: `models/TTS/voices/af_heart.pt` (American English, female)
- **Hindi Voice**: `models/TTS/voices/hf_alpha.pt` (Hindi, female)

Zero additional models or voice files were downloaded.

---

## 2. Runtime Environment & Dependencies

Installed inside `ai-service/.venv` (Python 3.11.17, Apple Silicon `arm64`):
- `kokoro==0.9.4`: Pure PyTorch StyleTTS2 architecture.
- `misaki==0.9.4`: Grapheme-to-phoneme engine.
- `espeakng-loader==0.2.4`: Prebuilt macOS ARM64 binary wheel providing eSpeak NG runtime and dictionary data (`espeak-ng-data`) for multilingual phonemization, specifically Hindi Devanagari.
- `soundfile==0.14.0`: In-memory RIFF WAV encoder/decoder.

---

## 3. Architecture & Service Design

### 3.1 Core Engine (`ai-service/app/services/kokoro_tts.py`)
- **`KokoroTTSEngine`**:
  - **Single Load & Persistence**: Loads `KModel` from `kokoro-v1_0.pth` and `config.json` exactly once during application startup. Reused across all synthesis requests.
  - **100% Offline Preloaded Voice Tensors**: In standard Kokoro, passing a string like `"af_heart"` triggers an automated call to HuggingFace Hub (`hf_hub_download`). To guarantee strict offline operation, `KokoroTTSEngine` preloads `af_heart.pt` and `hf_alpha.pt` directly into memory using `torch.load(path, weights_only=True)`. The in-memory `torch.FloatTensor` is passed directly into `pipeline(..., voice=tensor)`, completely bypassing network calls.
  - **Apple Silicon MPS Hardware Acceleration**:
    - Detects `torch.backends.mps.is_available()`.
    - Automatically maps the model to `mps:0`.
    - Built-in CPU fallback: If an MPS memory error or unsupported kernel occurs, it safely falls back to CPU.
  - **Automatic Language Detection**:
    - Inspects text for Unicode Devanagari range (`[\u0900-\u097F]`).
    - If Devanagari characters are detected, routes to `language="hi"`, voice=`"hf_alpha"`.
    - Otherwise defaults to `language="en"`, voice=`"af_heart"`.
    - Allows explicit override via `language` or `voice` parameters.
  - **Configurable Speed**: Supports speech playback rate scaling from 0.5x to 2.5x.
  - **In-Memory Streaming & WAV Formatting**: Uses `io.BytesIO` and `soundfile` to output standard 24 kHz 16-bit PCM WAV chunks without touching the physical filesystem.

### 3.2 Service Wrapper & API Route
- **`KokoroTTSService`**: Async thread-safe wrapper implementing the existing `TextToSpeechService` interface.
- **REST Endpoints**:
  - `POST /v1/tts/synthesize`: Synthesizes input text to WAV audio with response metadata headers (`X-TTS-Language`, `X-TTS-Voice`, `X-TTS-Speed`, `X-TTS-Duration`, `X-TTS-Device`).
  - `GET /v1/tts/status`: Returns engine readiness, device used (`mps` or `cpu`), sample rate (24,000 Hz), available voices, and supported languages (`["en", "hi"]`).

---

## 4. Hindi & English Audio Synthesis Results

Real audio samples were synthesized locally and verified:

### 4.1 English Audio Generation
- **Text**: `"Hello! I am GIA, your offline intelligent desktop assistant."`
- **Voice**: `af_heart`
- **Phonemes Used**: `həlˈO! ˌI ɐm ʤˌiˌIˈA, jʊɹ ˌɔflˈIn ɪntˈɛləʤᵊnt dˈɛsktˌɑp əsˈɪstᵊnt.`
- **Duration**: `4.70s`
- **Output File**: `ai-service/sample_en.wav` (220 KB, 24000 Hz, 16-bit mono)
- **Acceleration**: `device=mps`

### 4.2 Hindi Audio Generation (Devanagari Unicode)
- **Text**: `"नमस्ते! मैं जिया हूँ, आपकी ऑफलाइन इंटेलिजेंट सहायक।"`
- **Voice**: `hf_alpha`
- **Phonemes Used**: `nəmˈʌsteː! mɛ̃ ɟˈɪjaː hũ, ˌaːpkˌi ˌɔpʰlˈaːɪn ˌĩʈeːlɪɟˈẽːʈ səhˈaːjək`
- **Duration**: `5.00s`
- **Output File**: `ai-service/sample_hi.wav` (234 KB, 24000 Hz, 16-bit mono)
- **Acceleration**: `device=mps`
- **Phonemization Integrity**: Hindi Unicode text is not transliterated or converted to English; eSpeak NG preserves native Devanagari phonetics.

---

## 5. MPS GPU Acceleration Evidence

Runtime verification log from test execution on macOS Apple Silicon M1:
```text
PyTorch MPS available: True
Kokoro KModel successfully loaded on device: mps
Preloaded offline voice tensor 'af_heart': torch.Size([1, 512])
Preloaded offline voice tensor 'hf_alpha': torch.Size([1, 512])

English WAV: duration=4.70s, sample_rate=24000, channels=1, device=mps
Hindi WAV: duration=5.00s, sample_rate=24000, channels=1, device=mps
```

---

## 6. Test Suite Results

### 6.1 Kokoro TTS Tests (`ai-service/tests/test_tts.py`)
12 / 12 tests PASSED:
- `test_kokoro_model_loading_and_lifecycle`: PASSED
- `test_english_speech_generation`: PASSED
- `test_hindi_speech_generation`: PASSED
- `test_automatic_language_selection`: PASSED
- `test_explicit_voice_selection`: PASSED
- `test_speed_configuration`: PASSED
- `test_wav_format_validity`: PASSED
- `test_model_reuse_across_multiple_requests`: PASSED
- `test_cpu_and_mps_execution`: PASSED
- `test_empty_and_invalid_text_handling`: PASSED
- `test_async_service_wrapper`: PASSED
- `test_api_tts_endpoints`: PASSED

### 6.2 Full AI Service Voice Stack
- **Silero VAD (`tests/test_vad.py`)**: 12/12 PASSED
- **Whisper STT (`tests/test_stt.py`)**: 18/18 PASSED
- **Kokoro TTS (`tests/test_tts.py`)**: 12/12 PASSED
- **Total AI Service Tests**: **42 / 42 PASSED** (86.69s)

### 6.3 Full Backend Regression Suite
- **31 test files**: **285 / 285 PASSED** (11.76s)
- All authorization, execution tickets, plan-first security, and permission manager tests passed.

---

## 7. Files Created & Modified

### Created:
- `ai-service/app/services/kokoro_tts.py`
- `ai-service/tests/test_tts.py`
- `reports/PHASE_4_KOKORO_TTS_IMPLEMENTATION.md`
- `ai-service/sample_en.wav`
- `ai-service/sample_hi.wav`

### Modified:
- `ai-service/app/core/config.py` (Added Kokoro paths, provider config, and sample rate)
- `ai-service/app/schemas/tts.py` (Updated schema for speed configuration, synthesis results, and 24kHz status)
- `ai-service/app/services/tts_service.py` (Aliased global singleton to `gia_kokoro_service`)
- `ai-service/app/services/__init__.py` (Exported Kokoro classes)
- `ai-service/app/api/routes/tts.py` (Integrated speed, voice, language, and response metadata headers)

---

## 8. Remaining Blockers
- None. The TTS engine is 100% offline, fully functional, and ready for end-to-end voice loop integration.

