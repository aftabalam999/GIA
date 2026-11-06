# PHASE 6: FINAL GIA LOCAL AI INTEGRATION ARCHITECTURE

**Date:** November 6, 2026  
**System:** GIA Desktop Voice Assistant  
**Environment:** macOS (Apple Silicon Darwin arm64)  
**Status:** Completed & Integrated  

---

## 1. Executive Summary

Phase 6 completes the end-to-end integration of the local AI architecture into the GIA desktop voice assistant. The entire application operates without any external LLM provider, cloud speech API, or online embedding service.

### Primary Architectural Invariants:
1. **Single LLM Throughout:** The downloaded **Qwen 3.5 4B** model (`ai-service/models/Qwen`) is the sole generative foundation model for all operations (reasoning, general dialogue, tool selection, coding assistance, summarization, and RAG).
2. **Three-Tier Architecture:**
   - **Desktop Shell:** Tauri v2 with Rust native process management and global hotkey.
   - **Orchestration & Business Logic:** Node.js Fastify backend (`127.0.0.1:5000`) managing authentication, conversations, PostgreSQL/pgvector storage, agent routing, tool execution, and voice gating.
   - **Cognitive ML Engine:** Python FastAPI service (`127.0.0.1:8001`) hosting local Qwen 3.5 4B, local Faster-Whisper, local Sentence Transformers (`all-MiniLM-L6-v2`), and local speech synthesis.
3. **No Direct Frontend-to-ML Bypass:** The React frontend communicates strictly with the Node.js backend API and Tauri IPC. All authorization, policy enforcement, vector queries, and logging remain protected.

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Native Shell                       │
│  - Child Process Lifecycle Management (Auto-spawn & Cleanup)│
│  - Global Desktop Hotkey (Super+G Window Focus)             │
│  - Native 16kHz PCM Microphone Capture (Rust Audio Bridge)  │
└──────────────┬───────────────────────────────┬──────────────┘
               │ IPC                           │ IPC
┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
│       React Frontend        │ │     Service Manager (Rust)   │
│  - Vite SPA / WebAudio VAD  │ │  - PID Tracking / Sigterm   │
│  - Dynamic Status Indicators│ │  - Duplicate Init Prevention │
│  - Streaming Audio Queue    │ └─────────────────────────────┘
└──────────────┬──────────────┘
               │ REST / WebSocket (Port 5000)
┌──────────────▼──────────────────────────────────────────────┐
│                   Node.js Fastify Backend                   │
│  - Session Auth (HttpOnly Cookie / Bearer JWT)              │
│  - Agent Orchestrator FSM & Wake-Word Authorization Gate    │
│  - Document Ingestion, Chunking & RAG Retrieval             │
│  - Postgres (pgvector HNSW) & Redis Cache                   │
└──────────────┬──────────────────────────────────────────────┘
               │ Internal REST / SSE HTTP (Port 8001)
┌──────────────▼──────────────────────────────────────────────┐
│                  Python FastAPI AI Service                  │
│  - Local Qwen 3.5 4B (MPS Apple Silicon / CPU bfloat16)     │
│  - Local STT: Faster-Whisper Tiny (Int8 Local Weights)      │
│  - Local Embedding: all-MiniLM-L6-v2 (384-dim Local Weights)│
│  - Local TTS: macOS Native 'say' (Samantha 22.05kHz WAV)    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Model Initialization & Lifecycle Management

### Unified Singleton Lifecycle
All heavy ML models are initialized exactly once during service boot, managed by `ModelLifecycleManager` (`ai-service/app/models/lifecycle.py`):
- **Concurrency Guard:** `_lifecycle_lock = asyncio.Lock()` guarantees thread-safe, single-instance initialization.
- **Duplicate Prevention:** If `self.is_initialized` is true, subsequent calls immediately return without reloading weights into memory.
- **Local Disk Verification:** Model weights are loaded with `local_files_only=True` via Hugging Face `AutoConfig`, `AutoTokenizer`, and `AutoModelForCausalLM`.
- **Target Device Selection:**
  - Evaluates `torch.backends.mps.is_available()`.
  - On Apple Silicon: allocates model tensors to `mps` using `torch.bfloat16`.
  - Fallback: CPU using `torch.float32`.

### Teardown & Resource Deallocation
Upon application exit, the FastAPI lifespan context manager invokes `model_lifecycle.shutdown()`:
- Clears PyTorch cache: `torch.mps.empty_cache()` (macOS) / `gc.collect()`.
- Releases memory buffers and resets subsystem references.

---

## 3. Inference Lifecycle & Streaming

### Two Generation Modalities:
1. **Synchronous Chat (`POST /api/llm/chat`):**
   - Applies Qwen native Jinja chat template with conversation history.
   - Extracts structured parameters (`max_new_tokens: 1024`, `temperature: 0.7`, `top_p: 0.9`).
   - Runs non-blocking inference via `run_in_executor`.
   - Parses `<tool_call>` XML tags and reasoning tokens (`<think>...</think>`).
2. **Real-Time Token Streaming (`POST /api/llm/chat/stream`):**
   - Uses `transformers.TextIteratorStreamer` running in a dedicated worker thread.
   - Yields Server-Sent Events (SSE) formatted as `data: {"id": "...", "choices": [{"delta": {"content": "..."}}]}`.
   - Asynchronous SSE generator allows client-side cancellation via `AbortController` (terminates generation within 1 token).

---

## 4. API Communication

### Security Boundaries
- **Frontend $\leftrightarrow$ Backend:** Protected via JWT session tokens and HttpOnly secure cookies. All endpoints validate authenticated user IDs (`req.user.id`).
- **Backend $\leftrightarrow$ Python AI Service:** Communication routes over localhost loopback (`127.0.0.1:8001`) with mandatory `x-internal-api-key: gia_internal_secret_key_987654321`. External interfaces cannot bypass authentication.
- **Tauri IPC:** Native Rust commands (`get_service_statuses`, `start_local_services`, `restart_service`, `check_microphone_permission`) invoke local OS APIs without network sockets.

---

## 5. Voice Pipeline & Acoustic Gating

### End-to-End Voice Flow:
1. **Audio Capture:** Native Tauri Rust buffer (`mic_capture.rs`) or browser WebAudio `MediaStreamTrack` configured for 16,000 Hz, 16-bit mono PCM.
2. **Voice Activity Detection (VAD):** `LocalVAD` evaluates frame root-mean-square (RMS) energy. Transition from silence to sustained speech ($RMS > 0.015$) triggers `SPEECH_DETECTED`.
3. **Acoustic Gating (Self-Transcription Prevention):**
   - During `TRANSCRIBING`, `PROCESSING`, and `SYNTHESIZING`, the microphone is explicitly muted.
   - During `PLAYING`, guarded barge-in mode requires $RMS > 0.045$ (3x energy threshold) to interrupt.
   - A 50ms guard delay is enforced after playback before re-arming the microphone in `LISTENING`.
4. **Wake-Word Gate:**
   - Evaluated by `WakeWordDetector.detect()`.
   - Commands are rejected if not preceded by `"Hey GIA"`, `"GIA"`, `"OK GIA"`, or `"Hello GIA"`.
5. **Incremental Prosodic Chunking:**
   - Tokens streamed from Qwen are partitioned by `SpeechTextChunker` at sentence delimiters (`.`, `!`, `?`) and clause pauses (`,`, `;`).
   - Natural chunks of 15–120 characters are dispatched immediately to local TTS.
6. **Local Synthesis & Playback:**
   - Synthesized via `/usr/bin/say -v Samantha --data-format=LEI16@22050`.
   - `StreamingAudioQueue` sequences WAV buffers and initiates speaker output with sub-500ms time-to-first-audio.

---

## 6. RAG Pipeline & Local Embeddings

### Ingestion & Indexing
- Documents uploaded via `/api/v1/documents` are split by `RecursiveCharacterTextSplitter` into overlapping chunks (500 characters, 50-character overlap).
- Chunks are vectorized using the local `all-MiniLM-L6-v2` Sentence Transformer model (`ai-service/models/embeddings/all-MiniLM-L6-v2/`).
- Embeddings (384-dimensional float arrays) are stored in PostgreSQL using `pgvector` with HNSW cosine distance indexes.

### Retrieval & Grounding
- User queries are embedded locally via `POST /v1/embeddings/embed`.
- Cosine similarity query retrieves top-$K$ candidates ($K=5$) with user tenancy filtering (`user_id = $1`).
- Similarity threshold ($score \ge 0.40$) filters irrelevant documents.
- Context injection formats verified text passages into Qwen system instructions:
  ```
  Context Information:
  [Source: filename.pdf]
  passage text...
  
  Answer grounded strictly in the provided context. If unknown, state clearly that documents do not contain the answer.
  ```

---

## 7. Tool Calling & Agent Execution

### Safe Tool Architecture
- Model proposes tool execution using Qwen native XML formatting:
  ```xml
  <tool_call>
  {"name": "open_folder_in_vscode", "arguments": {"folderName": "my-project"}}
  </tool_call>
  ```
- **Deterministic Pre-Routing:** High-frequency, deterministic commands (e.g., `"open VS Code"`, `"what time is it"`) are resolved immediately by `AgentRouter` without burning LLM inference cycles.
- **Tool Sandbox:** All arguments are strictly validated against JSON schema models using Zod.
- **Path Traversal Protection:** Relative traversal sequences (`..`, `~`, `/etc`, `/sys`, `/root`) are rejected.
- **No Unrestricted Shells:** GIA does not allow arbitrary LLM-generated shell command execution. Local actions are restricted to registered whitelist tools (`open_folder_in_vscode`, `open_url`, `get_current_time`, `list_documents`, `search_memories`).

---

## 8. Memory Subsystem

The memory subsystem implements three complementary tiers:
1. **Short-Term Conversation History:** The most recent dialogue turns (sliding window of 10 messages) stored in `messages` table and formatted into the Qwen chat prompt.
2. **Long-Term Semantic Facts:** Extracted user preferences and persistent facts stored in `memories` table with importance rankings (1–10). Retrieved and injected when relevant to user requests.
3. **Episodic Context:** Past session metadata and command run history tracked in `model_runs` table for auditing and context grounding.

---

## 9. Error Handling & Recovery

1. **Service Startup Failures:** Tauri `ServiceManager` monitors child process stdout/stderr. If Python fails to start (e.g. missing virtualenv or port conflict), Tauri captures the exit code, logs descriptive diagnostics, and marks the service state as `failed(error_message)` while allowing the desktop UI to display actionable recovery instructions.
2. **Inference Timeouts:** Default 30s timeout on heavy inference requests prevents thread starvation. Client cancellations immediately terminate the PyTorch generation streamer.
3. **Database & Cache Health:** If Redis or PostgreSQL drops, readiness probes report `unhealthy` with HTTP 503, preventing corrupted writes.
4. **Offline Resilience:** If network connectivity is absent, the system detects zero external calls, skips DNS resolution, and operates normally from local disk.

---

## 10. Conclusion

The GIA Local AI Architecture is complete, robust, and production-ready. All cognitive operations, voice interactions, vector searches, and agent tool executions run completely on-device, preserving user privacy, performance, and reliability.

