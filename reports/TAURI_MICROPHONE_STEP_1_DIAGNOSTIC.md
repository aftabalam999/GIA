# Step 1 Diagnostic Report — GIA Tauri macOS Microphone Capture

**Date**: 2026-11-10  
**Platform**: macOS Darwin (Apple Silicon arm64)  
**Host Architecture**: Darwin Kernel Version 27.2 / macOS  
**Target Environments**:
- Browser Mode: Chrome / Safari / Firefox (`http://localhost:1420`)
- Native Desktop Mode: Tauri v2 WebKit WKWebView (`frontend/src-tauri/target/release/bundle/macos/GIA.app` & `target/debug/frontend`)

---

## Executive Summary

GIA voice mode functions correctly when loaded in a standard web browser because the browser provides native origin-based TCC permissions and a persistent, hardware-connected `MediaStream` to the Web Audio API. This enables `AudioRecorderService`, `LocalVAD`, and `MediaRecorder` to calculate real-time RMS volume (at 60 FPS via `requestAnimationFrame`), detect speech onset/offset dynamically, and dispatch complete voice utterances to the local Whisper STT service.

When running under Tauri on macOS, voice mode does not listen. This comprehensive diagnosis reveals two compounding root causes:

1. **First-tier Failure — WebKit `getUserMedia` Permission / TCC Rejection in Tauri**:
   - `AudioRecorderService.start()` always checks `navigator.mediaDevices.getUserMedia`. In Tauri's macOS `WKWebView`, `navigator.mediaDevices.getUserMedia` exists and is called.
   - However, during development (`npm run tauri:dev`), Tauri runs a raw unbundled Mach-O executable (`frontend/src-tauri/target/debug/frontend`). macOS TCC requires an Apple `.app` bundle structure with `[NSBundle mainBundle]` containing `NSMicrophoneUsageDescription`. As a result, WebKit rejects `getUserMedia` with `NotAllowedError`.
   - In `frontend/src-tauri/build.rs`, an attempt to link `Info.plist` into the binary via `-Wl,-sectcreate,__TEXT,__info_plist` resulted in two concatenated XML documents in the Mach-O section because `tauri-build` already injects an Info.plist section, causing malformed plist metadata.

2. **Second-tier Failure — Broken Native Fallback Capture Architecture**:
   - When `getUserMedia` fails, `AudioRecorderService` catches the exception and falls back to `startNativeCaptureLoop()`.
   - `mic_capture.rs` does not stream audio; instead, it executes a blocking 4-second external CLI command: `ffmpeg -f avfoundation -i :0 -t 4 ... /tmp/gia_mic_test.wav`.
   - **VAD Pipeline Disconnected**: In native capture mode, `this.analyser` is `null` and `monitorVolume()` never runs. `this.vad.processAudioFrame()` receives only a single scalar RMS value once every 4.3 seconds. Because `LocalVAD.minSpeechDurationMs` is 100ms and default frame duration is 50ms, `isSpeaking` is never set to `true`, `onSpeechStart` is never fired, and the UI never transitions to `SPEECH_DETECTED`.
   - **Silent Permission Masking**: When the user first launches the app, `handleGrantMicPermission()` in `App.tsx` catches the `getUserMedia` failure, calls `requestNativeMicrophonePermission()`, which executes a 0.5s probe with `ffmpeg`. Because CLI `ffmpeg` inherits terminal/shell permissions, it returns `status: "GRANTED"`, writing `gia_mic_permission = 'granted'` to `localStorage` and closing the modal. The app falsely indicates microphone access is granted, while WKWebView remains completely unauthorized.

---

## 1. Microphone Capture Paths

### Browser Mode Execution Path
1. **Trigger**: User clicks `🎙️ OFF` button $\to$ `App.tsx:toggleVoiceMode()`.
2. **State Machine**: Transitions `IDLE` $\to$ `STARTING` $\to$ `PLAYING` (welcome greeting) $\to$ `LISTENING`.
3. **Capture Start**: `AudioRecorderService.start()` detects `typeof navigator.mediaDevices.getUserMedia === 'function'`.
4. **Hardware Capture**: `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, ... } })` acquires live hardware `MediaStream`.
5. **Web Audio Graph**:
   - `AudioContext` created at 16,000 Hz.
   - `MediaStreamSourceNode` connects to `AnalyserNode` (`fftSize = 512`).
   - `MediaRecorder` buffers Opus/AAC audio slices at 100ms timeslices.
6. **VAD Loop**: `monitorVolume()` runs via `requestAnimationFrame` (60 FPS), computing real-time RMS from time-domain PCM samples:
   $$\text{RMS} = \sqrt{\frac{1}{N} \sum_{i=1}^{N} s_i^2}$$
7. **Utterance Segmentation**:
   - RMS $\ge 0.015$ for $\ge 100\text{ ms} \to \text{LocalVAD emits } \texttt{onSpeechStart} \to \texttt{VoiceStateMachine.handleSpeechStart()}$.
   - Silence for $\ge 650\text{ ms} \to \text{LocalVAD emits } \texttt{onSpeechEnd} \to \texttt{MediaRecorder.stop()}$.
   - Complete utterance Blob emitted to `VoiceStateMachine.processSpeechUtterance(blob)`.

### Tauri Mode Execution Path (Hybrid Implementation)
Tauri uses a **hybrid implementation** with an intended fallback:
1. **Primary Attempt**: WebKit `navigator.mediaDevices.getUserMedia()`.
2. **Secondary Fallback**: Native Rust IPC `request_microphone_permission` and `start_microphone_test_capture` via `startNativeCaptureLoop()`.

### Which Implementation is Actually Invoked in Tauri?
- `AudioRecorderService.start()` first attempts `navigator.mediaDevices.getUserMedia()`.
- Inside Tauri WKWebView, this **fails immediately** with `NotAllowedError`.
- The `catch` block catches the error:
  `WebAudio getUserMedia unavailable, falling back to desktop native capture:`
- Execution transfers to **Native Rust Capture Fallback** (`startNativeCaptureLoop()`).
- In this fallback loop:
  - Spawns `ffmpeg -y -f avfoundation -i :0 -t 4 ... /tmp/gia_mic_test.wav` via Tauri IPC.
  - Blocks for 4 seconds per iteration.
  - Passes a single average RMS scalar to `LocalVAD` once every 4.3 seconds.
  - The WebAudio `AnalyserNode` is `null`; `monitorVolume()` never executes.

---

## 2. macOS Microphone Permission Audit

| Component | Status | Findings |
|---|---|---|
| `Info.plist` Existence | **VERIFIED** | Located at `frontend/src-tauri/Info.plist`. Contains `NSMicrophoneUsageDescription`: *"GIA Assistant requires microphone access for voice commands and continuous listening."* |
| `tauri.conf.json` Registration | **VERIFIED** | Line 29: `"macOS": { "infoPlist": "Info.plist", "entitlements": "Entitlements.plist" }` registered under `bundle`. |
| Built `.app` Bundle Plist | **VERIFIED** | `frontend/src-tauri/target/release/bundle/macos/GIA.app/Contents/Info.plist` contains `NSMicrophoneUsageDescription` and `CFBundleIdentifier: com.jasin.gia`. |
| Entitlements | **VERIFIED** | `Entitlements.plist` contains `<key>com.apple.security.device.audio-input</key><true/>`. Binary is signed with this entitlement. |
| Debug Binary Mach-O Section | **CORRUPTED** | In `frontend/src-tauri/build.rs`, `println!("cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,...")` creates a duplicate section. In `target/debug/frontend`, two concatenated XML documents exist, causing parse failures. |
| Debug Executable Bundle Association | **FAILED** | `frontend/src-tauri/target/debug/frontend` is a standalone Mach-O binary (`CodeDirectory flags=0x20002(adhoc)`, `Info.plist=not bound`). macOS TCC blocks WKWebView media access for unbundled binaries. |
| Tauri WebView Permission Handler | **DEFAULT (PASS-THROUGH)** | In Tauri v2 / WRY (`wry_web_view_ui_delegate.rs:163`), `requestMediaCapturePermission` defaults to `WKPermissionDecision::Grant`. However, WebKit delegates actual hardware capture to macOS TCC. If TCC is unbundled or unauthorized, WebKit throws `NotAllowedError`. |
| Native Rust Permissions Check | **FLAWED** | `mic_capture.rs:check_permission_internal()` queries `system_profiler SPAudioDataType`, which only checks if hardware exists, not OS authorization. `request_permission_internal()` runs external `ffmpeg`, testing `ffmpeg`'s TCC permissions instead of `GIA.app`'s. |
| Silent Permission Masking | **CRITICAL DEFECT** | In `App.tsx:handleGrantMicPermission()`, when `getUserMedia` fails, it falls back to `requestNativeMicrophonePermission()`. The 0.5s `ffmpeg` probe succeeds in terminal/IDE contexts, causing `App.tsx` to set `localStorage.setItem('gia_mic_permission', 'granted')`. The app falsely treats denied WebKit permission as success. |

---

## 3. Microphone Initialization Trace & First Failing Operation

### Step-by-Step Execution Trace

```
[Voice Mode Start]
       │
       ▼
[App.tsx: toggleVoiceMode()] ──► isVoiceModeActive = true
       │
       ▼
[VoiceStateMachine.startVoiceMode()]
       ├──► Welcome greeting plays via DesktopAudioPlayer (TTS)
       └──► State transitions: STARTING ──► PLAYING ──► LISTENING
       │
       ▼
[AudioRecorderService.start()]
       │
       ├──► Check hasGetUserMedia: TRUE (WKWebView exposes mediaDevices)
       │
       ├──► [STEP 1: FIRST FAILING OPERATION]
       │    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, ... } })
       │    ❌ REJECTED: NotAllowedError: The request is not allowed by the user agent
       │       or the platform in the current context
       │
       ├──► Catch Block catches NotAllowedError
       │    Logs: "WebAudio getUserMedia unavailable, falling back to desktop native capture"
       │
       ▼
[Fallback: requestNativeMicrophonePermission()]
       │
       ├──► Rust IPC: check_microphone_permission ──► "GRANTED" (system_profiler detects mic)
       ├──► Rust IPC: request_microphone_permission ──► "GRANTED" (ffmpeg 0.5s probe succeeds)
       │
       ▼
[AudioRecorderService.startNativeCaptureLoop()]
       │
       ├──► AudioContext is NULL
       ├──► AnalyserNode is NULL
       ├──► monitorVolume() is NEVER called
       │
       ▼
[Tauri IPC: start_microphone_test_capture(4)]
       │
       ├──► Rust executes: `ffmpeg -f avfoundation -i :0 -t 4 /tmp/gia_mic_test.wav`
       ├──► Blocks synchronously for 4.0 seconds
       │
       ▼
[WAV Parsed & Returned to Frontend]
       │
       ├──► this._hasReceivedFrames = true
       ├──► this.vad.processAudioFrame(res.rms_volume)
       │    ⚠️ LocalVAD receives 1 frame (50ms). minSpeechDuration is 100ms.
       │    ❌ VAD never triggers onSpeechStart. VoiceStateMachine never enters SPEECH_DETECTED.
       │
       ├──► base64ToBlob -> callbacks.onUtteranceRecorded(blob)
       │
       ▼
[VoiceStateMachine.processSpeechUtterance(blob)]
       │
       ├──► Sends 4-second WAV to /api/v1/voice/transcribe (Whisper STT)
       ├──► If silent, Whisper returns "" -> returns to LISTENING
       └──► Loop sleeps 300ms, then starts ANOTHER 4-second blocking ffmpeg process
```

### Exact First Failing Operation
- **Operation**: `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, ... } })`
- **Location**: `frontend/src/services/audioRecorder.ts:142`
- **Actual Error Message**:
  ```
  NotAllowedError: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.
  ```
- **Consequence**: Bypasses the Web Audio graph (`AnalyserNode`, 60 FPS volume monitoring, and `LocalVAD`), plunging Tauri into a blocking, un-synchronized 4-second batch capture loop.

---

## 4. Safe Diagnostic Logs Added

Safe structured diagnostic logging was implemented in:
- `frontend/src/services/audioRecorder.ts`
- `frontend/src/services/tauriMicrophone.ts`
- `frontend/src/App.tsx`

### Logged Diagnostic Fields (No Raw Audio or Sensitive Data)

| Event Tag | Fields Logged |
|---|---|
| `[MIC_DIAGNOSTIC] start() initiated` | `runtimeType` (`tauri` \| `browser`), `hasGetUserMedia` (`boolean`) |
| `[MIC_DIAGNOSTIC] selectedCaptureImplementation` | Implementation selected (`webaudio_getusermedia` \| `tauri_native_capture`) |
| `[MIC_DIAGNOSTIC] captureStartResult` | `runtimeType`, `selectedCaptureImplementation`, `success`, `sampleRate`, `channelCount`, `audioFrameSize` |
| `[MIC_DIAGNOSTIC] firstAudioFrameReceived` | `runtimeType`, `selectedCaptureImplementation`, `sampleRate`, `channelCount`, `audioFrameSize`, `initialRms` |
| `[MIC_DIAGNOSTIC] captureError` | `runtimeType`, `selectedCaptureImplementation`, `errorName`, `errorMessage` |
| `[MIC_DIAGNOSTIC] checkNativeMicrophonePermission` | `runtimeType`, permission `status`, device name, status message |
| `[MIC_DIAGNOSTIC] requestNativeMicrophonePermission` | `runtimeType`, permission request `status`, status message |
| `[MIC_DIAGNOSTIC] toggleVoiceMode triggered` | `runtimeType`, `isVoiceModeActive`, `permissionState` (`prompt` \| `granted` \| `rejected`) |

---

## 5. Browser versus Tauri Execution Comparison

| Attribute | Browser Runtime | Tauri macOS Runtime | Impact |
|---|---|---|---|
| **Runtime Detection** | `isTauriEnvironment() === false` | `isTauriEnvironment() === true` | Environment gated correctly |
| **Primary Capture API** | `navigator.mediaDevices.getUserMedia` | `navigator.mediaDevices.getUserMedia` $\to$ rejected | Primary capture path fails in Tauri |
| **Error Encountered** | None (User grants permission in browser prompt) | `NotAllowedError` in `WKWebView` | Triggers fallback |
| **Fallback Path** | Not invoked | `startNativeCaptureLoop()` | Incompatible architecture |
| **Audio Pipeline** | Continuous in-memory `MediaStream` | 4-second batch WAV file via external `ffmpeg` | Destroys real-time interactivity |
| **Audio Graph State** | `AudioContext` active, `AnalyserNode` connected | `AudioContext` null, `AnalyserNode` null | No audio spectrum available |
| **Frame Delivery Rate** | 60 FPS (~16ms intervals) via `requestAnimationFrame` | 1 single RMS scalar every 4.3 seconds | LocalVAD starvation |
| **Speech Start Detection** | Dynamic: $\text{RMS} \ge 0.015$ for $\ge 100\text{ ms}$ | **Never fires**: single frame adds only 50ms | App never shows `SPEECH_DETECTED` |
| **Speech End Detection** | Dynamic: silence for $\ge 650\text{ ms}$ | Blind fixed 4-second slicing | Words split or clipped |
| **Utterance Quality** | Cleanly bounded speech audio | 4 seconds of ambient noise or split words | Whisper transcribes silence |
| **Latency** | Instantaneous streaming ($\approx 150\text{ ms}$) | High latency ($\ge 4300\text{ ms}$ minimum) | Completely broken UX |
| **Echo Suppression** | Instantaneous via `LocalVAD.setAudioInputEnabled(false)` | External subprocess cannot be paused mid-flight | Echo leaks during TTS |

---

## 6. Relevant Configuration Problems

1. **Unbundled Debug Binary Execution**:
   - `npm run tauri:dev` runs `frontend/src-tauri/target/debug/frontend` directly as a Mach-O binary.
   - macOS TCC does not permit media devices to standalone binaries lacking bundle identity.
2. **Double XML in Embedded Mach-O Section**:
   - `build.rs:8`:
     ```rust
     println!("cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}", plist_path.display());
     ```
   - `tauri-build` already compiles an `__info_plist` section. Adding `-Wl,-sectcreate` causes both plists to be concatenated end-to-end, creating an invalid XML document:
     ```xml
     </plist><?xml version="1.0" ...><plist>...
     ```
3. **Flawed Entitlement Mapping in Non-Sandboxed Debug Mode**:
   - `Entitlements.plist` is only embedded during `tauri build` packaging. The debug binary runs adhoc without signed entitlements.
4. **VAD Architecture Decoupled from Fallback Capture**:
   - `AudioRecorderService` assumes all capture goes through Web Audio `AnalyserNode`. The fallback bypasses the Web Audio graph entirely.

---

## 7. Minimal Recommended Fix

To resolve the Tauri microphone issue cleanly without breaking browser functionality:

### Recommended Architecture: Unify Browser and Tauri on WebKit `getUserMedia`

The cleanest, most maintainable fix is to make WebKit's `getUserMedia` succeed inside Tauri so that browser and desktop share the exact same battle-tested audio pipeline (`AudioContext` $\to$ `AnalyserNode` $\to$ `LocalVAD` $\to$ `MediaRecorder`).

1. **Clean `build.rs` Plist Embedding**:
   - Remove the redundant `-Wl,-sectcreate` linker argument from `frontend/src-tauri/build.rs` to avoid corrupting the Mach-O plist section. Let `tauri.conf.json` manage bundle Info.plist cleanly.
2. **Explicit Webview Media Capture Permission Grant in Rust**:
   - In `frontend/src-tauri/src/lib.rs`, configure the `tauri::Builder` or `WebviewBuilder` to explicitly permit media capture on the main window via `on_permission_request` if necessary.
3. **Run / Test in App Bundle Structure**:
   - Ensure development testing runs the bundled application (`GIA.app`) or a symlinked `.app` wrapper so that macOS TCC associates microphone permissions with `com.jasin.gia`.
4. **Harden `App.tsx` Permission Gating**:
   - Remove the silent fallback in `handleGrantMicPermission()` that treats `ffmpeg` CLI success as WebKit permission.
   - If `getUserMedia` fails in `App.tsx`, keep the permission state accurate and guide the user to grant macOS System Settings access for GIA.
5. **Stream Native Audio If Fallback is Required**:
   - If native capture fallback is ever needed as a backup, replace the 4-second blocking `ffmpeg` subprocess with a native streaming capture thread (using CoreAudio/cpal) that pushes PCM chunks to `LocalVAD` at 16 kHz.

---

## Conclusion & Next Steps

The diagnosis is complete. Diagnostic logs are safely in place. No voice pipeline, Whisper, Silero VAD, Kokoro, or permission security architectures were modified.

Per the instructions:
> *"Do not implement the fix yet. Stop after creating the diagnostic report."*

Execution is now halted pending instructions for Step 2.

