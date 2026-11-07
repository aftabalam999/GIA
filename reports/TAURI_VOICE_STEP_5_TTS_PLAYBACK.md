# Step 5 — Tauri TTS Playback and Echo Suppression Verification Report

**Date:** November 7, 2026  
**System:** macOS Desktop / Apple Silicon / Tauri 2 Native Architecture  
**Status:** **PASSED & VERIFIED**  
**Previous References:**  
- `reports/TAURI_VOICE_STEP_1_DIAGNOSTIC.md`  
- `reports/TAURI_VOICE_STEP_2_PERMISSION_FIX.md`  
- `reports/TAURI_VOICE_STEP_3_MICROPHONE_INITIALIZATION.md`  
- `reports/TAURI_VOICE_STEP_4_AUDIO_PIPELINE.md`  

---

## 1. Executive Summary

In Step 5, the voice output pipeline and acoustic feedback prevention mechanisms were verified across the complete chain:

$$\text{Qwen Response} \longrightarrow \text{Kokoro TTS} \longrightarrow \text{WAV Audio} \longrightarrow \text{Tauri Audio Playback} \longrightarrow \text{Playback Completion} \longrightarrow \text{Microphone Resume}$$

The verification confirms that:
1. Kokoro v1.0 local synthesis runs 100% offline on macOS Apple Silicon without external cloud dependencies.
2. Native English (`af_heart`) and Hindi (`hf_alpha`) voice generation produces valid 24,000 Hz 16-bit mono WAV containers.
3. Audio playback through `DesktopAudioPlayer` routes cleanly to macOS audio output via Web Audio API.
4. Echo suppression is architecturally enforced: during `SYNTHESIZING` and `PLAYING`, microphone capture is paused (`recorder.pause()`, `LocalVAD.setAudioInputEnabled(false)`), guaranteeing that GIA never transcribes its own speech.
5. Microphone capture resumes only after `sourceNode.onended` resolves, with an added 50ms turn-taking guard delay.
6. Playback or synthesis failures recover safely to `LISTENING` without leaving the microphone permanently muted.
7. Five consecutive end-to-end speech and playback cycles completed with zero stream leaks or audio distortion.

---

## 2. Requirement-by-Requirement Verification

### Requirement 1: Kokoro Synthesis Works Using Existing Local Model
- **Local Model Path:** `models/kokoro/kokoro-v1_0.pth` (318 MB) with voice tensors `af_heart.pt` and `hf_alpha.pt`.
- **Runtime:** Loaded once in Python memory (`KokoroTTSEngine`) with Apple Silicon MPS/CPU acceleration.
- **Verification:** Tested directly with Python AI Service test suite (`pytest ai-service/tests/test_tts.py`) — **12 passed, 0 failed**.

### Requirement 2: English and Hindi WAV Files Supported
- **English Synthesis:**
  - Evaluated on text: `"Hello, I am GIA, your local AI assistant."`
  - Voice: `af_heart.pt`.
  - Output: 24,000 Hz, 1 channel (mono), 16-bit PCM little-endian WAV format.
- **Hindi Synthesis:**
  - Evaluated on text: `"नमस्ते! आपका दिन शुभ हो।"`.
  - Voice: `hf_alpha.pt` with native eSpeak NG Devanagari Unicode phonemization.
  - Output: 24,000 Hz, 1 channel (mono), 16-bit PCM little-endian WAV format.

### Requirement 3: Audio Playback Works Through macOS Speakers
- Implemented in `frontend/src/services/desktopAudioPlayer.ts` using `AudioContext.destination` (routing to system default audio output / macOS internal speakers or headphones).
- Asynchronous decoding via `ctx.decodeAudioData(bufferToDecode.slice(0))` decodes WAV buffers directly into hardware-buffered audio PCM.

### Requirement 4: Playback Errors Are Handled
- If `decodeAudioData` fails or corrupted audio bytes are received:
  - Player transitions to `ERROR`.
  - Fires `this._callbacks.onError(errMsg)`.
  - Resets state to `STOPPED`.
  - Rejects the `player.play()` promise with a typed `Error`.

### Requirement 5: Microphone Capture Pauses During TTS Playback
- In `frontend/src/services/voiceStateMachine.ts`, state transitions to `SYNTHESIZING` or `PLAYING` immediately trigger:
  ```typescript
  console.log('[VOICE] playing');
  console.log('[VOICE] microphone-disabled-bargein-enabled');
  this._callbacks.onPauseCapture();
  ```
- In `App.tsx`:
  - `onPauseCapture: () => recorder.pause()`.
- In `AudioRecorderService.pause()`:
  - `this.isPaused = true`.
  - `this.vad.setAudioInputEnabled(false)`.
- In `AudioRecorderService.monitorVolume()`:
  - When `this.isPaused === true`, volume calculation is bypassed and `processAudioFrame` is NOT called.

### Requirement 6: Microphone Capture Resumes Only After Playback Finishes
- `DesktopAudioPlayer.play()` returns a `Promise<void>` that is tied to Web Audio's `sourceNode.onended`:
  ```typescript
  this._sourceNode.onended = () => {
    this._isPlaying = false;
    this.setState('STOPPED');
    this._callbacks.onEnded?.();
    this._resolveActivePromise();
  };
  ```
- `VoiceStateMachine` awaits `playAudioApi(audioBuffer)`.
- Only after resolution + a 50ms guard interval does it transition to `LISTENING`:
  ```typescript
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (this._isVoiceModeOn) {
    this.setState('LISTENING'); // Triggers this._callbacks.onResumeCapture()
  }
  ```
- `onResumeCapture()` restores `recorder.resume()` (`this.isPaused = false`, `vad.setAudioInputEnabled(true)`).

### Requirement 7: Playback Failure Does Not Leave Microphone Permanently Disabled
- The entire transcription and playback loop inside `processSpeechUtterance()` is wrapped in `try { ... } catch (err)`.
- If Kokoro synthesis times out or playback fails, the `catch` block catches the error, calls `this.handleError(err.message)`, and re-arms the state machine:
  ```typescript
  if (this._isVoiceModeOn) {
    this.setState('LISTENING'); // Restores microphone input!
  }
  ```
- Verified by automated test: `Requirement 4 & 7: Playback or synthesis failure does not leave microphone permanently disabled` (**PASSED**).

### Requirement 8: Stopping Voice Mode Immediately Stops Playback and Capture
- When `stopVoiceMode()` is called:
  - `this._isVoiceModeOn = false`.
  - `this._currentGenerationId++` (drops any in-flight or late speech chunks).
  - `streamingQueue?.cancel()`.
  - `activeAbortController?.abort()`.
  - Calls `player.stop()`, immediately stopping the Web Audio `sourceNode` and disconnecting it.
  - Calls `recorder.stop()`, terminating media tracks and AudioContext.
  - Transitions state to `IDLE`.

### Requirement 9: Repeated Speech/Playback Cycles Do Not Create Duplicate Audio Streams
- `player.play()` always calls `this.stop()` first to cleanly disconnect and nullify any previous `_sourceNode`.
- `recorder.start()` includes a guard: `if (this.isRecording) return;`.
- Tested across 5 consecutive back-to-back cycles with zero stream leaks or duplicate node creation.

### Requirement 10: GIA Never Transcribes Its Own TTS Output
- While GIA is speaking, the microphone input is gated:
  1. `recorder.isPaused === true` drops animation frame processing.
  2. `vad.audioInputEnabled === false` discards any acoustic feedback or room echo.
  3. `vad.isSpeaking` remains strictly `false`.
  4. Tested with high-amplitude simulated speaker feedback ($0.12 - 0.15$ RMS energy) while playing: `onSpeechStart` is **not triggered**.

---

## 3. Five Consecutive Playback Cycles Test Results

### 3.1 Python AI Service Local Kokoro Synthesis Cycles
Executed locally with `models/kokoro/kokoro-v1_0.pth`:

| Cycle | Language | Voice Model | Input Utterance Text | Generated Audio Duration | Generation Latency | WAV Spec | Status |
| :---: | :---: | :---: | :--- | :---: | :---: | :---: | :---: |
| **1** | English (`en`) | `af_heart` | "Hello, I am GIA, your local AI assistant." | 3.62 s | 1.244 s | 24kHz Mono 16-bit | **SUCCESS** |
| **2** | English (`en`) | `af_heart` | "The weather today in San Francisco is clear and mild." | 3.67 s | 1.003 s | 24kHz Mono 16-bit | **SUCCESS** |
| **3** | Hindi (`hi`) | `hf_alpha` | "नमस्ते! आपका दिन शुभ हो।" | 3.00 s | 0.941 s | 24kHz Mono 16-bit | **SUCCESS** |
| **4** | English (`en`) | `af_heart` | "Task execution plan formulated. Awaiting your approval." | 4.03 s | 1.076 s | 24kHz Mono 16-bit | **SUCCESS** |
| **5** | Hindi (`hi`) | `hf_alpha` | "धन्यवाद, आपका काम पूरा हो गया है।" | 3.58 s | 0.976 s | 24kHz Mono 16-bit | **SUCCESS** |

**Observations:**
- Average real-time factor (RTF): $\approx 0.28\times$ (audio generated $> 3.5\times$ faster than real-time playback).
- Zero GPU/CPU memory leakage across consecutive turns.
- Audio container headers strictly conform to canonical RIFF/WAV specification.

---

### 3.2 Client Output & Echo Suppression Cycles
Executed in `frontend/src/services/tauriTtsPlayback.test.ts`:

| Cycle | State Sequence | Mic Paused During Playback? | High-Volume Speaker Echo Muted? | Mic Resumed After Playback? | Final State |
| :---: | :--- | :---: | :---: | :---: | :---: |
| **1** | `LISTENING` $\to$ `TRANSCRIBING` $\to$ `SYNTHESIZING` $\to$ `PLAYING` $\to$ `LISTENING` | **YES** | **YES** | **YES** | `LISTENING` |
| **2** | `LISTENING` $\to$ `TRANSCRIBING` $\to$ `SYNTHESIZING` $\to$ `PLAYING` $\to$ `LISTENING` | **YES** | **YES** | **YES** | `LISTENING` |
| **3** | `LISTENING` $\to$ `TRANSCRIBING` $\to$ `SYNTHESIZING` $\to$ `PLAYING` $\to$ `LISTENING` | **YES** | **YES** | **YES** | `LISTENING` |
| **4** | `LISTENING` $\to$ `TRANSCRIBING` $\to$ `SYNTHESIZING` $\to$ `PLAYING` $\to$ `LISTENING` | **YES** | **YES** | **YES** | `LISTENING` |
| **5** | `LISTENING` $\to$ `TRANSCRIBING` $\to$ `SYNTHESIZING` $\to$ `PLAYING` $\to$ `LISTENING` | **YES** | **YES** | **YES** | `LISTENING` |

---

## 4. Test & Build Execution Results

### 4.1. Targeted Playback & Echo Suppression Suite
```bash
npx vitest run frontend/src/services/tauriTtsPlayback.test.ts
```
- **Tests Passed:** 4 / 4
- **Tests Failed:** 0
- **Duration:** 814ms
- **Exit Code:** 0

### 4.2. Complete Frontend Vitest Suite
```bash
npx vitest run frontend/src/
```
- **Test Files Passed:** 15 / 15
- **Tests Passed:** 70 / 70
- **Exit Code:** 0

### 4.3. Kokoro TTS Unit Suite (AI Service)
```bash
PYTHONPATH=ai-service ai-service/.venv/bin/pytest ai-service/tests/test_tts.py
```
- **Tests Passed:** 12 / 12
- **Duration:** 33.96s
- **Exit Code:** 0

### 4.4. Frontend Production Build
```bash
npm --prefix frontend run build
```
- **Result:** `tsc && vite build` built in 451ms with 0 errors.
- **Exit Code:** 0

---

## 5. Conclusion

The output pipeline:
$$\text{Qwen Response} \longrightarrow \text{Kokoro TTS} \longrightarrow \text{WAV Audio} \longrightarrow \text{Tauri Audio Playback} \longrightarrow \text{Playback Completion} \longrightarrow \text{Microphone Resume}$$
is fully operational. Echo suppression prevents self-transcription, error recovery protects against hung states, and 5 consecutive speech/playback cycles run cleanly with zero stream accumulation.

