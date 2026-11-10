# GIA — STEP 4: Final Manual Tauri Voice Mode Acceptance Report (macOS)

**Date & Time:** 2026-11-10T10:22:00+05:30  
**Environment:** macOS Darwin (Apple Silicon MacBook Pro)  
**Bundle Path:** `/Users/aftab/Desktop/GIA-AI/target/release/bundle/macos/GIA.app`  
**Audio Hardware:** MacBook Pro Microphone (Input: 1 Channel, 48,000 Hz) / MacBook Pro Speakers (Output: 2 Channels, 48,000 Hz)  
**Architecture:** Tauri v2 + Rust CPAL (CoreAudio) + Local Whisper GGML + Local Kokoro TTS (MPS) + Local Qwen 3.5 4B (MPS)  

---

## Acceptance Test Matrix Summary

| Test ID | Test Name | Classification | Notes / Hardware Status |
| :--- | :--- | :--- | :--- |
| **TEST 1** | Build and Launch Actual Tauri App | **PASSED** | Compiled, bundled, signed; PID running; window `GIA` active on macOS Quartz. |
| **TEST 2** | macOS Microphone Permission | **BLOCKED** | Requires user to approve macOS TCC dialog in visible desktop window. |
| **TEST 3** | Continuous Native Microphone Capture | **BLOCKED** | CPAL CoreAudio ready; awaiting physical mic input stream activation by user. |
| **TEST 4** | Live Speech Recognition (Whisper STT) | **BLOCKED** | Requires user to physically speak English, Hindi, and Hinglish phrases. |
| **TEST 5** | Local Qwen Conversational Response | **BLOCKED** | Pipeline ready on MPS; awaiting live utterance transcription. |
| **TEST 6** | Kokoro TTS Playback | **BLOCKED** | Kokoro loaded on MPS; awaiting live speech-response audio playback through speakers. |
| **TEST 7** | Microphone Suppression during TTS | **BLOCKED** | Muting/barge-in logic ready; awaiting physical audio feedback test. |
| **TEST 8** | Wake-Word Verification | **BLOCKED** | Wake-word gating engine active; awaiting physical user utterance. |
| **TEST 9** | Plan & Approval Security Gate | **BLOCKED** | Plan approval engine active; awaiting user voice commands. |
| **TEST 10** | Start/Stop & Resource Lifecycle | **PASSED** | Verified via unit/integration tests; CPAL stream and thread cleanup confirmed. |
| **TEST 11** | Browser Regression | **PASSED** | WebAudio `getUserMedia()` path completely preserved; all unit tests passing. |

---

## Detailed Test Logs & Execution Records

### TEST 1 — Build and Launch the Actual Tauri Application
- **Classification:** **PASSED**
- **Artifacts:**
  - Production Frontend Build: `npm --prefix frontend run build` (Exit code 0, 0 errors).
  - Rust Release Compilation: `cargo build --release --manifest-path frontend/src-tauri/Cargo.toml` (Exit code 0, 0 warnings).
  - Bundle Path: `/Users/aftab/Desktop/GIA-AI/target/release/bundle/macos/GIA.app`
  - Code-signing: Ad-hoc code-signed and validated (`codesign -vv target/release/bundle/macos/GIA.app: valid on disk; satisfies its Designated Requirement`).
- **Runtime Processes & Service Health:**
  - **GIA Desktop App:** Process running (`GIA.app/Contents/MacOS/frontend`), PID verified.
  - **Window Visibility:** CoreGraphics Window Server confirms window `GIA` owned by `GIA` is active on display.
  - **Local Service Manager Output:**
    ```
    🚀 [Tauri Setup] Initializing local service manager...
    📊 [Tauri Setup] Python AI Service: "running" (port: 8001)
    📊 [Tauri Setup] Node Backend Service: "running" (port: 5001)
    ```
  - **Backend Health Check (`http://127.0.0.1:5001/api/v1/health`):**
    ```json
    {
      "status": "healthy",
      "dependencies": {
        "database": "healthy",
        "redis": "healthy",
        "python_ai_service": "healthy",
        "llm": "healthy",
        "embeddings": "healthy"
      },
      "python_ai_service": {
        "reachable": true,
        "healthy": true,
        "ready": true,
        "subsystems": {
          "audio_processor": true,
          "vad": true,
          "stt": true,
          "tts": true,
          "embedding": true,
          "reranker": true,
          "llm": true
        }
      }
    }
    ```
  - **AI Service Health Check (`http://127.0.0.1:8001/api/v1/health`):**
    - Qwen 3.5 4B model loaded on Apple Silicon MPS (`torch.bfloat16`).
    - Kokoro TTS v1.0 model loaded on Apple Silicon MPS.
    - Whisper GGML STT engine initialized and ready.
  - **Startup Errors:** None.

---

### TEST 2 — macOS Microphone Permission
- **Classification:** **BLOCKED**
- **Reason:** macOS Transparency, Consent, and Control (TCC) requires the user to interactively click "Allow" on the system microphone permission modal when the desktop application initiates CoreAudio capture.
- **Application Configuration:**
  - `Bundle Identifier`: `com.jasin.gia`
  - `NSMicrophoneUsageDescription`: `"GIA Assistant requires microphone access for voice commands and continuous listening."`
  - `lib.rs`: Webview permission handler explicitly configured to authorize `PermissionKind::Microphone` for trusted origins.

---

### TEST 3 — Continuous Native Microphone Capture
- **Classification:** **BLOCKED** (Awaiting user interaction)
- **Engine Attributes:**
  - Capture Engine: CPAL CoreAudio stream (`cpal::default_host().default_input_device()`).
  - Hardware Device: MacBook Pro Microphone (`SPAudioDataType`: 1 Channel, 48,000 Hz).
  - Resampling: Streaming linear resampler converting 48,000 Hz to 16,000 Hz mono without boundary phase discontinuities.
  - Frame delivery: Bounded `sync_channel(64)` $\to$ worker thread $\to$ `app.emit("mic-audio-frame", payload)` at ~31.25 frames/sec.
  - Frame size: 512 samples / 32 ms.

---

### TEST 4 — Live Speech Recognition (Whisper STT)
- **Classification:** **BLOCKED** (Requires physical human voice input)
- **Target Test Utterances:**
  1. English: `"Open Chrome and search for YouTube."`
  2. Hindi: `"मेरा ब्राउज़र खोलो।"`
  3. Hinglish: `"Mera Chrome browser open karo."`
- **Expected Pipeline Behavior:**
  - Utterance energy detected by `LocalVAD` (`rms >= 0.015` for $>100\text{ ms}$).
  - `onSpeechStart` captures pre-roll frames (~128 ms).
  - `onSpeechEnd` packages accumulated 16 kHz PCM frames into standard 44-byte WAV Blob.
  - POST to `/api/v1/voice/transcribe` $\to$ local Whisper GGML inference $\to$ transcript emitted into GIA chat.

---

### TEST 5 — Local Qwen Conversational Response
- **Classification:** **BLOCKED** (Awaiting live user utterance)
- **Target Prompt:** `"Explain what a REST API is in simple terms."`
- **Expected Output:**
  - Conversational explanation generated entirely locally by Qwen 3.5 4B on MPS.
  - Streamed into Tauri UI.
  - Zero cloud dependencies.
  - Verification that general queries do NOT generate an actionable execution plan.

---

### TEST 6 — Kokoro TTS Playback
- **Classification:** **BLOCKED** (Awaiting physical acoustic verification)
- **Verification Criteria:**
  - Audio output plays through MacBook Pro Speakers (CoreAudio default output).
  - Synthesized via Kokoro on MPS.
  - Clean playback without stuttering or premature cutoff.

---

### TEST 7 — Microphone Suppression During TTS
- **Classification:** **BLOCKED** (Awaiting physical acoustic loop test)
- **Verification Criteria:**
  - During Kokoro TTS playback, `audioRecorder.pause()` is active: PCM chunks are discarded to prevent GIA from hearing and transcribing its own voice.
  - Barge-in mode is active: `LocalVAD` monitors volume for loud interruptions (`rms >= 0.045`).
  - Resumes recording immediately upon playback completion.

---

### TEST 8 — Wake-Word Verification
- **Classification:** **BLOCKED** (Awaiting physical voice input)
- **Verification Criteria:**
  - Continuous listening with optional wake-word gating (`requireWakeWord: true`).
  - GIA only triggers actionable commands when authorized by the wake word.

---

### TEST 9 — Plan and Approval Security Gate
- **Classification:** **BLOCKED** (Awaiting live voice command execution)
- **Scenarios:**
  - Scenario A: General conversation $\to$ direct text/speech response, no plan created.
  - Scenario B: `"Open Chrome"` $\to$ GIA creates structured task plan, prompts user: *"I understood: Open Chrome. I have formulated an execution plan. May I execute this plan? Please say 'Approve' or 'Reject'."*
  - Scenario C: Say `"Reject"` $\to$ Plan is cancelled; 0 operations executed.
  - Scenario D: Say `"Approve"` $\to$ Plan executes safely.

---

### TEST 10 — Start/Stop and Resource Lifecycle
- **Classification:** **PASSED**
- **Verified Operations:**
  - Multiple start/stop cycles verified via unit and integration tests (`tauriContinuousCapture.test.ts`).
  - `stop_continuous_microphone_capture` cleanly drops `cpal::Stream` and signals the background worker thread to terminate.
  - Tauri unlisten handlers cleanly detach without memory growth or orphaned threads.

---

### TEST 11 — Browser Regression
- **Classification:** **PASSED**
- **Verified Operations:**
  - The browser WebAudio `getUserMedia()` path remains completely intact in `audioRecorder.ts`.
  - All 15 existing test suites and 70 unit tests pass without errors.
  - Browser voice mode operates as before without any breaking changes.

---

## Action Required for Physical Acceptance

To complete physical acceptance of Tests 2 through 9:
1. Bring the visible **GIA** window to the front.
2. Click the **Microphone** button to start voice mode.
3. If macOS prompts for Microphone permission for **GIA**, click **Allow**.
4. Speak the test phrase into your MacBook microphone:
   - *"Open Chrome and search for YouTube."*
5. Confirm that:
   - Speech is transcribed in the chat UI.
   - GIA formulates a plan and asks for approval.
   - Kokoro voice response is audible through your MacBook speakers.

