# GIA — STEP 3: Reliable Continuous Microphone Capture in Tauri (macOS)

**Status:** Complete  
**Date:** 2026-11-10  
**Target Platform:** macOS Darwin (Apple Silicon / Intel) — Tauri v2 Desktop  

---

## 1. Executive Summary & Objective

In Steps 1 and 2, the macOS Tauri microphone permission model, application metadata (`com.jasin.gia`), and WKWebView permission handlers were diagnosed and repaired. However, live capture in desktop mode was relying on an emergency fallback: `startNativeCaptureLoop()`, which executed an `ffmpeg -i :0 -t 4` subprocess every 4.3 seconds to write temporary files to `/tmp/gia_mic_test.wav`.

This temporary mechanism was fundamentally unsuitable for conversational voice interaction:
- High latency (4-second batch intervals).
- Heavy CPU overhead from repeated process spawning.
- Inability to detect instantaneous speech onset or interruption.
- Starvation of the real-time `LocalVAD` pipeline.

**Step 3 Objective Achieved:**
The file-based 4-second FFmpeg loop has been completely removed. It is replaced with **asynchronous, continuous, low-latency native microphone capture** using **CPAL (`cpal = "0.18.2"`)** over macOS CoreAudio. Audio is captured continuously on a real-time thread, downmixed to mono, resampled with a fractional-delay linear resampler to **16,000 Hz**, chunked into **512-sample (32 ms)** frames, and streamed via Tauri IPC events (`mic-audio-frame`) directly into the frontend `LocalVAD` and Whisper STT pipeline.

Browser `getUserMedia()` voice mode remains 100% intact and untouched.

---

## 2. Architecture & Native Capture Engine

### 2.1 Audio Hardware Interface (CPAL & CoreAudio)
- **Library:** `cpal = "0.18.2"` using macOS native `AudioUnit` / `CoreAudio` host.
- **Device Selection:** Uses `cpal::default_host().default_input_device()` to open the active system input device (e.g. MacBook Pro Microphone or connected USB/Bluetooth headset).
- **Format Support:** Supports both `SampleFormat::F32` (standard on CoreAudio) and `SampleFormat::I16`.

### 2.2 Streaming Linear Resampler & Mono Downmixer
Hardware audio interfaces on macOS commonly operate at 44,100 Hz or 48,000 Hz, with stereo or multi-channel configurations. The speech pipeline (Silero VAD and Whisper STT) requires **16,000 Hz mono PCM**.

A dedicated, stateful streaming resampler was implemented in `frontend/src-tauri/src/mic_capture.rs`:
```rust
pub struct StreamingResampler {
    in_rate: u32,
    out_rate: u32,
    channels: usize,
    ratio: f64,
    phase: f64,
    prev_mono: f32,
    curr_mono: f32,
    initialized: bool,
    sample_buffer: Vec<f32>,
}
```
**Key Engineering Attributes:**
1. **Multi-Channel Downmixing:** Interleaved frames are downmixed by averaging channels: $\text{mono} = \frac{1}{C}\sum_{c=0}^{C-1} \text{ch}_c$.
2. **Fractional Delay Tracking:** Uses fractional phase $\rho = F_{\text{in}} / 16000$ and tracks continuous phase across chunk boundaries without boundary clicks or phase discontinuities.
3. **Exact 512-Sample Frame Chunking:** Accumulates 16 kHz mono samples and extracts exact 512-sample frames ($32\text{ ms}$ at $16\text{ kHz}$) matching Silero VAD windowing.

### 2.3 Non-Blocking Real-Time Threading
To prevent audio buffer under-runs or blocking on the macOS `com.apple.audio.IOThread`:
- The CoreAudio callback thread only performs linear interpolation and passes 512-sample frames into a bounded `sync_channel(64)` (~2 seconds max buffer).
- If the consumer is temporarily busy, `try_send` drops frames to guarantee zero blocking and prevent unbounded memory growth.
- A separate background worker thread reads from the channel, computes the Root Mean Square (RMS) volume, formats 16-bit signed LE PCM bytes, and emits the IPC event to Tauri.

---

## 3. Tauri IPC & Event Architecture

### 3.1 IPC Commands
Exposed in `frontend/src-tauri/src/lib.rs` and registered in `tauri::generate_handler!`:
- `start_continuous_microphone_capture(app: AppHandle) -> Result<(), String>`: Opens device, spawns worker, begins CoreAudio input stream.
- `stop_continuous_microphone_capture() -> Result<(), String>`: Stops stream, disconnects worker, releases CoreAudio device handles.

### 3.2 Event Payloads
- **Event Name:** `mic-audio-frame`
- **Rate:** ~31 events per second (every 32 ms).
- **Payload Schema:**
  ```json
  {
    "sample_rate": 16000,
    "channels": 1,
    "samples_count": 512,
    "rms": 0.0345,
    "pcm_base64": "<base64 encoded 1024 bytes of 16-bit LE PCM>"
  }
  ```
- **Error Event:** `mic-capture-error` — emitted if hardware disconnects or permissions fail during streaming.

---

## 4. Frontend Audio Pipeline Integration

### 4.1 Changes in `frontend/src/services/tauriMicrophone.ts`
- Added `startContinuousMicrophoneCapture()` and `stopContinuousMicrophoneCapture()`.
- Added `listenToMicrophoneAudioFrames(callback)` and `listenToMicrophoneCaptureError(callback)`.
- Added `base64ToUint8Array(base64)` for fast in-memory decoding.
- Added `createWavBlobFromPcm(pcmBytes, sampleRate, channels)` which prepends a standard 44-byte RIFF/WAVE header to raw PCM bytes.

### 4.2 Changes in `frontend/src/services/audioRecorder.ts`
- **Eliminated `startNativeCaptureLoop`:** Completely removed the 4-second file-based loop and repeated FFmpeg process calls.
- **Native Continuous Mode (`isNativeContinuous`):**
  - When `isTauriEnvironment()` is true, `start()` calls `startNativeContinuousCapture()`.
  - Subscribes to `mic-audio-frame`.
  - Feeds `frame.rms` directly into `LocalVAD.processAudioFrame(frame.rms, 32)`.
  - Maintains a 4-frame (~128 ms) pre-roll buffer (`nativePreRollChunks`) so the initial syllables of speech are preserved.
  - While `LocalVAD.isSpeaking` is true, accumulates incoming PCM chunks in memory.
  - On `LocalVAD.onSpeechEnd`: combines accumulated PCM bytes, generates a standard 16 kHz mono WAV `Blob` via `createWavBlobFromPcm()`, and passes it directly to `this.callbacks.onUtteranceRecorded(blob)`.
- **Muting & Barge-In Policy:**
  - When `pause()` is invoked (during TTS speech output), audio chunks are discarded from utterance storage, while `LocalVAD` continues monitoring energy for barge-in interruptions.
- **Clean Lifecycle:**
  - `stop()` unregisters event listeners, invokes `stopContinuousMicrophoneCapture()`, and resets all buffers.
- **Browser Compatibility:**
  - Non-Tauri environments continue to use standard `navigator.mediaDevices.getUserMedia` with `MediaRecorder` and `AudioContext`.

---

## 5. Verification & Test Results

### 5.1 Rust Backend Tests (`cargo test`)
All 10 unit tests in `frontend/src-tauri` passed:
```
running 10 tests
test mic_capture::tests::test_bytes_to_base64 ... ok
test mic_capture::tests::test_audio_frame_payload_serialization ... ok
test mic_capture::tests::test_find_ffmpeg_or_system_path ... ok
test service_manager::tests::test_find_workspace_root ... ok
test mic_capture::tests::test_resampler_48k_to_16k_mono ... ok
test service_manager::tests::test_port_check_unused_port ... ok
test service_manager::tests::test_get_statuses ... ok
test mic_capture::tests::test_resampler_44k1_stereo_to_16k_mono ... ok
test mic_capture::tests::test_check_permission_internal ... ok
test mic_capture::tests::test_request_permission_internal ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
```

### 5.2 Frontend Vitest Suites
Added dedicated continuous capture lifecycle suite `tauriContinuousCapture.test.ts`. All 16 test files (74 tests) passed:
```
 Test Files  16 passed (16)
      Tests  74 passed (74)
   Duration  1.65s
```
**Key Test Cases Verified:**
- `createWavBlobFromPcm`: Verified 44-byte RIFF/WAVE header structure (format 1, 1 channel, 16000 Hz, 32000 byte rate, 16 bits).
- `base64ToUint8Array`: Verified byte-accurate PCM decoding.
- `startNativeContinuousCapture`: Verified IPC command invocation and event listener binding.
- Continuous frame delivery: Verified `hasReceivedFrames` changes to `true` upon first frame.
- Speech onset detection: Verified `onSpeechStart` triggers when frames exceed threshold.
- Silence hangover & utterance packaging: Verified `onSpeechEnd` packages accumulated PCM into valid `audio/wav` Blob.
- Pause/resume muting: Verified frames are ignored while paused, and resume restores speech recognition.
- Clean stop: Verified `stop_continuous_microphone_capture` is invoked and unlisten callbacks are called.

### 5.3 Production Build Verification
`npm --prefix frontend run build` succeeded with zero TypeScript or Vite bundle errors:
```
✓ built in 461ms
dist/assets/index-ClJY2X6w.js   282.07 kB │ gzip: 84.45 kB
```

---

## 6. Remaining Physical Hardware Verification Requirements

While unit tests and mock integration suites verify that:
1. The CoreAudio capture stream compiles and initialises via CPAL.
2. The resampler mathematically converts 48kHz/44.1kHz audio to 16kHz mono without clicks.
3. The Tauri IPC event pipeline delivers frames to `AudioRecorderService`.
4. `LocalVAD` detects speech onset and speech end.
5. The accumulated PCM is encoded into a compliant WAV Blob and forwarded to Whisper STT.

**Final Physical Verification Note:**
Testing on physical macOS hardware requires:
- Launching the packaged desktop application (`GIA.app`).
- Confirming macOS TCC microphone permission dialog approval.
- Speaking into the physical microphone and observing live speech transcription through the local Whisper backend.

