# Step 1 Diagnostic Report — GIA Tauri macOS Microphone Failure

**Date**: 2026-11-07  
**Platform**: macOS Darwin (Apple Silicon arm64)  
**Host Version**: macOS 27.2 (Darwin Kernel)  
**Target Applications**:
- Browser Mode: Chrome / Safari / Firefox (`http://localhost:1420`)
- Native Desktop Mode: Tauri v2 (`frontend/src-tauri/target/debug/frontend`)

---

## Executive Summary

GIA continuous voice mode works in the browser because standard web browsers handle origin-based user permission dialogs and provide a direct, hardware-connected `MediaStream` to the Web Audio API. This allows `AudioRecorderService`, `LocalVAD`, and `MediaRecorder` to calculate real-time RMS audio levels, detect speech boundaries, and stream complete voice utterances to the Whisper STT service.

In the native Tauri macOS application, voice mode fails to capture speech. The investigation reveals two compounding failures:
1. **WebKit `getUserMedia` Access Failure**: Inside Tauri's macOS `WKWebView`, `navigator.mediaDevices.getUserMedia` fails with `NotAllowedError` because the development executable (`frontend/src-tauri/target/debug/frontend`) runs as a bare UNIX Mach-O binary rather than inside an Apple `.app` bundle, preventing macOS TCC from locating the `NSMicrophoneUsageDescription` in `[NSBundle mainBundle]`.
2. **Flawed Native Desktop Fallback Architecture**:
   - `mic_capture.rs` hardcodes a fake `status: "GRANTED"` response on macOS without calling `AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio` or requesting actual OS-level microphone access.
   - The native capture fallback (`startNativeCaptureLoop`) attempts to capture audio by spawning external `ffmpeg` subprocesses in blocking 4-second intervals writing to `/tmp/gia_mic_test.wav`.
   - **VAD Disconnection**: Because `AudioRecorderService.monitorVolume()` requires an active Web Audio `AnalyserNode` (which only exists when `getUserMedia` succeeds), `monitorVolume()` never runs in native capture mode. `LocalVAD` receives zero audio frames, never emits `onSpeechStart` or `onSpeechEnd`, and leaves the state machine disconnected from actual speech events.

---

## 1. Browser Microphone Architecture

In a standard web browser environment:

1. **Permission & Initialization**:
   - `AudioRecorderService.start()` tests for `navigator.mediaDevices.getUserMedia`.
   - Invokes:
     ```ts
     navigator.mediaDevices.getUserMedia({
       audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
     });
     ```
   - The browser presents its standard permission dialog to the user (`Allow localhost to use your microphone?`).
   - Upon user approval, an active `MediaStream` track is returned.

2. **Web Audio Pipeline**:
   - `AudioContext` is created: `new AudioContext()`.
   - A `MediaStreamAudioSourceNode` is connected to an `AnalyserNode` (`fftSize = 512`).
   - `MediaRecorder` is instantiated with a browser-supported MIME type (e.g. `audio/webm;codecs=opus` on Chromium or `audio/mp4` on Safari/macOS).
   - `MediaRecorder.start(100)` buffers audio data in 100ms chunks.

3. **VAD Driving Loop**:
   - `monitorVolume()` runs continuously via `requestAnimationFrame`.
   - Grabs time-domain PCM samples via `analyser.getFloatTimeDomainData(...)` (or fallback byte data).
   - Computes RMS volume:
     $$\text{RMS} = \sqrt{\frac{1}{N} \sum_{i=1}^{N} s_i^2}$$
   - Feeds RMS into `LocalVAD.processAudioFrame(rms)`.

4. **Speech Event Lifecycle**:
   - When $\text{RMS} \ge 0.015$ for $\ge 100\text{ ms}$, `LocalVAD` fires `onSpeechStart()`.
   - `VoiceStateMachine` transitions from `LISTENING` $\to$ `SPEECH_DETECTED`.
   - When speech ceases ($\text{silence} \ge 650\text{ ms}$), `LocalVAD` fires `onSpeechEnd()`.
   - `MediaRecorder.stop()` triggers `onstop`, aggregating audio chunks into a `Blob`.
   - `VoiceStateMachine.processSpeechUtterance(blob)` dispatches the audio to `/api/v1/voice/transcribe` (Whisper STT).

---

## 2. Tauri Microphone Architecture

Tauri mode is designed as a **hybrid fallback implementation**, but both layers encounter critical obstacles:

```
[AudioRecorderService.start()]
           │
           ▼
[Check: hasGetUserMedia?] ──► Yes (In WKWebView)
           │
           ▼
[navigator.mediaDevices.getUserMedia()]
           │
           ├──► Fails (NotAllowedError / TCC Plist missing from raw debug binary)
           │
           ▼ (catch block: Fallback to Desktop Native Capture)
[requestNativeMicrophonePermission()] ──► Tauri IPC ('request_microphone_permission')
           │
           ▼
[Rust: mic_capture.rs]
           ├──► Returns hardcoded mock: { status: "GRANTED", device_name: "MacBook Pro Microphone" }
           │    (Never calls AVCaptureDevice or prompts macOS TCC)
           │
           ▼
[startNativeCaptureLoop()]
           │
           ├──► AnalyserNode is NULL ──► monitorVolume() NEVER RUNS!
           │                             LocalVAD receives ZERO audio frames!
           │
           ▼
[startNativeMicrophoneTestCapture(4)] ──► Tauri IPC ('start_microphone_test_capture', duration: 4s)
           │
           ▼
[Rust: spawn external `ffmpeg -f avfoundation -i :0 -t 4 ... /tmp/gia_mic_test.wav`]
           │
           ├──► Blocks synchronously for 4 seconds
           ├──► Reads file with `hound`, converts to base64
           ▼
[base64ToBlob -> onUtteranceRecorded(blob)]
           │
           ▼
[VoiceStateMachine.processSpeechUtterance(blob)]
           └──► Whispers 4-second chunk -> Returns empty string if silent -> Loops
```

---

## 3. Exact Differences Between Browser and Tauri

| Attribute | Browser Mode | Tauri Desktop Mode |
|---|---|---|
| **Primary Capture Mechanism** | `navigator.mediaDevices.getUserMedia` | Hybrid attempt: WebKit `getUserMedia` $\to$ Fallback to Rust IPC |
| **OS Permission Prompt** | Native browser origin security bubble | Faked in Rust (`"GRANTED"`); no OS TCC prompt triggered |
| **Audio Data Flow** | In-memory continuous Web Audio `MediaStream` | 4-second batch WAV file written to disk via external `ffmpeg` |
| **VAD Integration** | Active: 60 FPS `requestAnimationFrame` driving `LocalVAD` | **Inactive**: `this.analyser` is `null`; `LocalVAD` never runs |
| **Speech Boundary Detection** | Natural speech start/stop detection via silence hangover | Blind 4-second fixed slicing regardless of when speech occurred |
| **Mute / Barge-In Control** | Instantaneous: `vad.setAudioInputEnabled(false)` | External subprocess cannot be paused; requires `pkill -f ffmpeg` |
| **Error Resiliency** | Standard DOM Exception handling | Fails silently into a blocking 4-second polling loop |

---

## 4. First Suspected Failing Operation

The failure sequence consists of three chained breakdown points:

1. **Breakdown Point 1 — WebKit Media Capture Rejection**:
   - `AudioRecorderService.start()` calls `navigator.mediaDevices.getUserMedia(...)`.
   - Inside macOS `WKWebView`, this throws:
     ```
     NotAllowedError: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.
     ```
   - **Reason**: The process being run in development is `frontend/src-tauri/target/debug/frontend` (a standalone Mach-O executable), not a bundled macOS `.app`. `[NSBundle mainBundle]` has no `Info.plist` with `NSMicrophoneUsageDescription`. macOS TCC blocks WebKit media access.

2. **Breakdown Point 2 — Faked Permission in Rust (`mic_capture.rs:131-139`)**:
   ```rust
   pub fn request_permission_internal() -> MicPermissionResult {
       if cfg!(target_os = "macos") {
           return MicPermissionResult {
               status: "GRANTED".to_string(),
               device_name: Some("MacBook Pro Microphone".to_string()),
               message: "Desktop microphone access acquired successfully.".to_string(),
           };
       }
       ...
   }
   ```
   - The fallback immediately claims permission is `GRANTED` without verifying macOS TCC authorization or invoking `AVCaptureDevice.requestAccess(for: .audio)`.

3. **Breakdown Point 3 — VAD Architecture Disconnect in Native Loop**:
   - In `AudioRecorderService.startNativeCaptureLoop()`, audio is captured via `startNativeMicrophoneTestCapture(4)` (running `ffmpeg` for 4 seconds).
   - Because `this.analyser` was only created in the `getUserMedia` try-block, `this.analyser` remains `null`.
   - `monitorVolume()` immediately returns:
     ```ts
     if (!this.isRecording || !this.analyser) return;
     ```
   - `LocalVAD.processAudioFrame()` is **never called**.
   - As a result, speech detection events are never fired, the state machine never transitions to `SPEECH_DETECTED`, and the UI is left unresponsive or looping blind 4-second empty transcriptions.

---

## 5. Relevant Error Messages Observed and Traced

1. **In WebKit Console / Catch Handler**:
   ```
   WebAudio getUserMedia unavailable, falling back to desktop native capture: NotAllowedError: The request is not allowed by the user agent or the platform in the current context
   ```
2. **In Rust FFmpeg Subprocess (if AVFoundation device index :0 is not permitted or busy)**:
   ```
   Error opening input file :0.
   Error opening input files: Input/output error
   ```
3. **In State Machine UI Banner**:
   ```
   [PROCESSING] ⚡ Processing speech (Silero VAD & Whisper STT)...
   ```
   *(Occurs when an utterance or empty audio block is sent to Whisper, or watchdog timer holds the state).*

---

## 6. Root Cause

1. **Host Bundle Missing at Runtime**:
   `Info.plist` with `NSMicrophoneUsageDescription` exists at `frontend/src-tauri/Info.plist` and is referenced in `tauri.conf.json` under `bundle.macOS.infoPlist`. However, during `npm run tauri:dev`, Tauri runs `cargo run`, producing an unpackaged binary at `target/debug/frontend`. macOS TCC does not associate `Info.plist` with unbundled binaries, causing WebKit's `getUserMedia` to fail unconditionally.
2. **Disconnected VAD Architecture in Native Fallback**:
   The native desktop fallback was implemented as a batch recording test (`ffmpeg` recording a 4-second file) rather than an audio stream. It has no integration with `AudioContext`, `AnalyserNode`, or `LocalVAD`. Because the speech state machine relies on `LocalVAD` to detect utterances, the fallback cannot operate continuous voice mode.

---

## 7. Recommended Minimal Fix

To fix Tauri without breaking browser mode:

### Strategy A: Enable WebKit `getUserMedia` in Tauri (Preserves Identical Code Path)
1. **Bundle/Package Development App**: Ensure the macOS build runs from a `.app` bundle structure (e.g. `cargo tauri build` or generating a symlinked `.app` wrapper in debug) so `[NSBundle mainBundle]` contains `NSMicrophoneUsageDescription`.
2. **Handle WKWebView Permissions in Rust**: In `frontend/src-tauri/src/lib.rs`, configure the webview builder or window setup to allow media capture permissions if required by WebKit.
3. **Web Audio Context State Handling**: In `audioRecorder.ts`, ensure `audioContext.resume()` is explicitly called on user gesture to avoid WebKit's autoplay/suspended audio context policy.
4. **Benefit**: Browser and Tauri use the exact same `MediaStream` $\to$ `AnalyserNode` $\to$ `LocalVAD` $\to$ `MediaRecorder` pipeline with zero platform discrepancies.

### Strategy B: Stream Native PCM Samples to `LocalVAD`
If WebKit `getUserMedia` cannot be used in a specific desktop environment:
1. Replace the blocking 4-second `ffmpeg` subprocess in `mic_capture.rs` with a native real-time audio stream (using `cpal` or CoreAudio) running on a background thread.
2. Emit PCM sample chunks to the frontend via Tauri IPC events: `app_handle.emit("mic-pcm-chunk", samples)`.
3. In `audioRecorder.ts`, subscribe to `mic-pcm-chunk` and pass the Float32 samples directly to `this.vad.processAudioFrame(pcmSamples)`.
4. Buffer samples into an utterance buffer while `LocalVAD.isSpeaking` is true, and emit the complete WAV blob when `onSpeechEnd` fires.

---

## 8. Files That Would Need Modification

1. `frontend/src-tauri/tauri.conf.json` (Verify bundle and window permissions)
2. `frontend/src-tauri/Info.plist` (Ensure correct bundle path and entitlement keys)
3. `frontend/src-tauri/src/mic_capture.rs` (Remove fake `GRANTED` mock; implement genuine permission checks or native stream)
4. `frontend/src-tauri/src/lib.rs` (Register window media capture settings or native stream handlers)
5. `frontend/src/services/tauriMicrophone.ts` (Match IPC signatures)
6. `frontend/src/services/audioRecorder.ts` (Ensure AudioContext resumption and proper VAD feeding in native mode)
7. `frontend/src/App.tsx` (Ensure seamless error reporting if microphone permission is denied by the OS)

---

*(Investigation complete. No source code has been modified in accordance with strict rules).*

