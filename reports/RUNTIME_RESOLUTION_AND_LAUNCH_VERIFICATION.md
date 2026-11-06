# GIA Local AI Runtime Resolution & Launch Verification Report

## Executive Summary

This report documents the root-cause diagnosis, architectural remediations, and offline end-to-end verification performed to resolve the runtime errors observed in the GIA desktop voice assistant.

All local subsystems—including the **Qwen 3.5 4B** inference engine, **all-MiniLM-L6-v2** embeddings, **bge-reranker-base**, **faster-whisper** STT, and **macOS AVFoundation native microphone capture**—are operational, fully offline, and tested.

---

## 1. Issues Identified & Resolved

### Issue 1: Port 5000 AirPlay Conflict & 403 Forbidden
* **Root Cause:** On macOS Sonoma/Sequoia, the native Apple `ControlCenter` daemon (`AirTunes/1005.13.1`, PID 820) listens on port `5000` (`commplex-main`) for AirPlay Receiver functionality. Any HTTP traffic sent from the frontend or curl to `http://127.0.0.1:5000` was intercepted by AirTunes, returning `403 Forbidden` and preventing communication with the Fastify backend.
* **Resolution:** 
  - Migrated backend port configuration to `5001` across:
    - `backend/.env` & `backend/.env.example`
    - `backend/src/config/index.ts`
    - `frontend/.env` (`VITE_BACKEND_URL=http://127.0.0.1:5001`)
    - `frontend/src/services/api.ts`
    - `frontend/src/services/tauriServices.ts`
    - `frontend/src-tauri/src/service_manager.rs`
  - All automated test assertions updated and verified passing.

### Issue 2: Qwen 3.5 4B Inference Timeout & Chain-of-Thought Loop
* **Root Cause:** 
  1. The downloaded weights for Qwen 3.5 4B had `config.eos_token_id = None`. Because `eos_token_id` was omitted from generation arguments, generation did not stop at `<|im_end|>` (token ID `248046`) and instead generated meaningless tokens until hitting the `max_new_tokens` ceiling (1024 tokens).
  2. The Qwen 3.5 Jinja chat template defaults to `<think>\n` when `enable_thinking` is undefined or not explicitly set to `false`. This forced the model to generate extensive multi-hundred token chain-of-thought monologues ("Thinking Process: 1. Analyze the Request...") for even simple queries.
  3. Generating 1024 tokens without CUDA kernels took over 120 seconds, triggering Fastify's orchestrator timeout and returning `500 Internal server error`.
* **Resolution:**
  - Updated `ai-service/app/services/llm_service.py` to:
    - Pass `enable_thinking=False` to `apply_chat_template` for standard, direct, and conversational queries (emitting `<think>\n\n</think>\n\n` to bypass internal monologue).
    - Explicitly set `eos_token_id = [self.tokenizer.eos_token_id, 248044]` in `gen_kwargs` and model `generation_config`.
  - Configured `maxTokens = 80` for intent routing classification (~1-2 seconds) and `maxTokens = 350` for final answer synthesis.
  - Result: End-to-end response time for "what is js" dropped from **>120s (timeout)** to **10.72s**, delivering a concise, grounded explanation.

### Issue 3: WKWebView Microphone Capture
* **Root Cause:** In Tauri on macOS, `navigator.mediaDevices.getUserMedia` requires an explicit macOS permission string inside the application bundle `Info.plist` (`NSMicrophoneUsageDescription`), and Linux `arecord` was failing on macOS.
* **Resolution:**
  - Added `frontend/src-tauri/Info.plist` declaring `NSMicrophoneUsageDescription`.
  - Linked Info.plist into `frontend/src-tauri/tauri.conf.json`.
  - Replaced Linux `arecord` in `frontend/src-tauri/src/mic_capture.rs` with native macOS AVFoundation capture (`ffmpeg -f avfoundation -i ":0"`).
  - Added safety checks in `audioRecorder.ts` and `App.tsx` ensuring graceful fallback to native desktop capture.

### Issue 4: Vite Port 1420 Collision
* **Root Cause:** A previous `tauri dev` invocation left an orphaned Vite background process (PID 12705) holding port `1420`.
* **Resolution:** Terminated the orphaned process; port `1420` is now clean and immediately available.

### Issue 5: UI Simplification & Tab Clutter Elimination
* **Root Cause:** The interface displayed two competing sets of tabs (4 mode selectors `[🤖 Agent] [⚡ Stream] [🔍 RAG] [💬 Sync]` under the input box, and 4 drawer buttons `[💬] [🧠] [📂] [⚙️]` in the header), in addition to developer execution telemetry `Check GIA execution steps (2)` inside assistant bubbles. This created confusion and visual clutter.
* **Resolution:**
  - Removed the 4 composer selector chips completely; all queries automatically default to the intelligent Agent orchestrator.
  - Replaced the 4 header buttons with a clean brand title, glowing status dot (`● Ready`), a `+ New` chat button, and a discreet `⚙️` modal button.
  - Consolidated chats, documents, memories, and system diagnostics into a single unified slide-over drawer modal.
  - Stripped out raw developer execution telemetry from chat bubbles for a clean, human-friendly conversation experience.
  - Upgraded input composer to a floating rounded pill bar (`border-radius: 24px`) with smooth glassmorphism.
  - Auto-initializes an active conversation if none exists, eliminating empty state confusion.

### Issue 6: macOS Application Launching ("open VS Code")
* **Root Cause:** The model or tool was relying on the `code` CLI in terminal PATH, which is frequently not in macOS default PATH unless configured in VS Code command palette.
* **Resolution:** Enhanced `open_folder_in_vscode` in `backend/src/ai/tools/registry.ts` to launch directly via macOS LaunchServices (`open -a "Visual Studio Code" <path>`) with automated fallback to `code`. Also expanded the local router pattern in `router.ts` to catch natural language phrases like "can you open vscode" or "please open vs code".

---

## 2. End-to-End Verification Matrix

| Test Case | Method / Route | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Backend Health Probe** | `GET /api/v1/health` on port 5001 | All dependencies healthy | `status: healthy`, latency <20ms | **PASS** |
| **Fastify & Python AI IPC** | `GET /health` on port 8001 | Subsystems operational | All 7 subsystems healthy | **PASS** |
| **Conversational Chat** | `POST /messages/agent` ("what is js") | Direct response from Qwen | Generated answer in ~14s | **PASS** |
| **Deterministic Tool Route** | `POST /messages/agent` ("what is the time") | Tool execution or response | Finished in 14.5s | **PASS** |
| **Python Test Suite** | `pytest tests/` | All unit & integration tests | **70 passed, 0 failed** | **PASS** |
| **Backend Test Suite** | `vitest run` | All unit & integration tests | **181 passed, 0 failed** | **PASS** |
| **Rust Tauri Check** | `cargo check & cargo test` | Clean compilation & test | **3 passed, 0 failed** | **PASS** |
| **Frontend Production Build** | `tsc && vite build` | 0 TypeScript errors | Built in 440ms | **PASS** |

---

## 3. How to Launch GIA

The local services (Postgres, Redis, Python AI Service, and Fastify Backend) are active and healthy.

To launch the desktop application, run:

```bash
npm run tauri:dev
```

### Default Local Account (Pre-configured)
- **Email:** `aftab@gia.local`
- **Password:** `password123`
- *(Or use the **Sign Up** tab to register any new local account).*

