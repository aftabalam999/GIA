# PHASE 1: COMPLETE AI ARCHITECTURE AUDIT REPORT — GIA

**Project:** GIA (Personal Desktop AI Voice Assistant)  
**Target:** Full Migration to Local AI Architecture with Downloaded **Qwen 3.5 4B** as the Single LLM  
**System Profile:** Apple M1 Pro (10-Core Apple Silicon, `arm64`), 32 GB Unified Memory, macOS Darwin 27.2.0  
**Audit Date:** 2026-11-06  
**Audit Status:** Completed — Strictly Read-Only (Zero Functional Modifications Applied)

---

## Executive Summary

The existing GIA codebase is currently in a transitional state:
1. **Cloud Lock-in:** The project was recently refactored (commit `908f34f`) to route all LLM conversational capabilities through **Google Gemini** (`gemini-3.6-flash` via Generative Language REST/SSE and `gemini-2.0-flash-exp` via `@google/genai` Multimodal Live API). Legacy OpenAI (`gpt-4o-mini`, `text-embedding-3-small`) and Anthropic (`claude-3-5-sonnet`) provider wrappers still exist in the repository but are bypassed by the centralized router.
2. **Dual Voice Pipelines:** 
   - **Pipeline 1 (Cloud Multimodal Live):** Frontend `VoiceEngine` / `GeminiLiveClient` connects via WebSocket `/api/v1/voice/live` to `GeminiLiveService`, streaming raw 16kHz audio directly to Google Gemini's cloud, which returns 24kHz audio and transcriptions.
   - **Pipeline 2 (Local REST Orchestration):** Frontend `VoiceStateMachine` captures speech chunks via local energy-based VAD (`LocalVAD`), posts to `/api/v1/voice/chat`, transcribes using the Python AI Service (`Faster-Whisper`), processes through the Node.js `AgentOrchestrator` FSM, and synthesizes audio via Python TTS (`Piper`/neural).
3. **Local Qwen 3.5 4B Model Location:** The model repository is already downloaded on disk at `/Users/aftab/Desktop/GIA-AI/models/Qwen3.5-4b/` (total weight size: ~9.32 GB across 2 safetensors files).
4. **Immediate Environment Roadblock:** The existing `ai-service/.venv` is broken on this host. It contains hardcoded paths (`/home/jasin/Desktop/GIA-AI/...`) and Linux `x86_64` compiled binaries copied from an external Linux machine, causing `bad interpreter` errors on macOS `arm64`. Furthermore, the `ai-service/app/` code was deleted from the working tree (though fully preserved in Git HEAD at commit `23fc9b3`).

---

## A. Existing AI Architecture
Yeah same Chico next voice control professional P extension Naam Ki Koti direct block subject
```mermaid
flowchart TD
    subgraph Client ["Desktop Client (Tauri + React 19)"]
        UI["React UI (App.tsx)"]
        VE["VoiceEngine / GeminiLiveClient"]
        VAD["LocalVAD (RMS Energy)"]
        VAP["LiveAudioPlayer / DesktopAudioPlayer"]
    end

    subgraph Backend ["Node.js Fastify Backend (Port 5000)"]
        direction TB
        Server["Fastify Server (server.ts)"]
        
        subgraph RealtimeRoute ["Realtime Voice"]
            WSRoute["/api/v1/voice/live (WebSocket)"]
            GLS["GeminiLiveService (@google/genai)"]
        end
        
        subgraph Orchestration ["Agentic FSM & Orchestrator"]
            Orch["AgentOrchestrator.run()"]
            ARouter["AgentRouter.route() (fast slot)"]
            CB["ContextBuilder"]
            Tools["ToolExecutor (Registry)"]
            RAG["RAGService"]
            Mem["MemoryService"]
        end

        subgraph Gateway ["Centralized LLM Gateway"]
            LLMG["LLMGateway (router/index.ts)"]
            RConfig["ROUTER_CONFIGS (config.ts)"]
            GProv["GeminiProvider (REST / SSE)"]
            OProv["OpenAIProvider (Unused)"]
            AProv["AnthropicProvider (Unused)"]
        end

        subgraph Embeddings ["Embedding Gateway"]
            ERouter["getEmbeddingProvider()"]
            OAIEmb["OpenAIEmbeddingProvider"]
            PyEmb["PythonEmbeddingProvider"]
        end
    end

    subgraph Storage ["Persistent Data Layer"]
        PG[("PostgreSQL 17 + pgvector (1536 dim)")]
        Redis[("Redis (Port 6379, Sessions)")]
    end

    subgraph PythonService ["Python AI Service (Port 8001 - FastAPI)"]
        FastAPI["FastAPI ML Service"]
        Whisper["WhisperSTTService (faster-whisper)"]
        Piper["GIATextToSpeechService (piper/neural)"]
        BGE["GIARerankerService (bge-reranker-base)"]
        LocalEmb["GIAEmbeddingService (1536 dim)"]
    end

    subgraph CloudAPIs ["External Cloud AI Providers"]
        GeminiLiveCloud["Google Gemini Multimodal Live API"]
        GeminiGenCloud["Google Generative Language API"]
        OpenAICloud["OpenAI API (Embeddings & Chat)"]
        AnthropicCloud["Anthropic API (Messages)"]
    end

    %% Audio & Voice Flows
    VE -->|16kHz PCM Base64 WS| WSRoute
    WSRoute --> GLS
    GLS <-->|Bidirectional Audio/Text WS| GeminiLiveCloud
    GLS -->|24kHz PCM Base64 WS| VE
    VE --> VAP

    %% Text Chat & Orchestration Flows
    UI -->|REST / WS| Server
    Server --> Orch
    Orch --> ARouter
    ARouter -->|Intent Routing Call| LLMG
    Orch --> RAG
    Orch --> Mem
    Orch --> Tools
    Orch -->|Final Response Generation| LLMG
    
    %% Gateway Routing
    LLMG --> RConfig
    RConfig --> GProv
    GProv -->|HTTPS REST / SSE| GeminiGenCloud
    OProv -.->|HTTPS REST| OpenAICloud
    AProv -.->|HTTPS REST| AnthropicCloud

    %% RAG & Memory
    RAG --> ERouter
    Mem --> ERouter
    ERouter --> OAIEmb
    ERouter --> PyEmb
    OAIEmb -.-> OpenAICloud
    PyEmb --> FastAPI
    RAG --> PG
    Mem --> PG

    %% Python ML Subsystem
    Server -->|AIServiceClient (HTTP / multipart)| FastAPI
    FastAPI --> Whisper
    FastAPI --> Piper
    FastAPI --> BGE
    FastAPI --> LocalEmb
```

---

## B. All Online AI Providers & Their File Paths

| Provider | Integration Type | File Path | Line Range | Mechanism / Protocol |
| :--- | :--- | :--- | :--- | :--- |
| **Google Gemini** | Multimodal Live API (Bidirectional Audio/Text) | `backend/src/ai/services/geminiLive.service.ts` | Lines 1–404 | `@google/genai` SDK (`ai.live.connect`), persistent WebSocket |
| **Google Gemini** | Live WebSocket Route Wrapper | `backend/src/api/routes/voiceLive.ts` | Lines 1–270 | Wraps `GeminiLiveService`, forwards client audio & tool execution |
| **Google Gemini** | Text & Streaming Generation | `backend/src/ai/providers/gemini.provider.ts` | Lines 1–140 | Native `fetch` to `https://generativelanguage.googleapis.com/v1beta/models/...:generateContent` & `:streamGenerateContent` |
| **Google Gemini** | Stream Chunker Abstraction | `backend/src/ai/services/geminiStream.service.ts` | Lines 1–122 | Streams Gemini tokens and slices into spoken clauses |
| **Google Gemini** | Router Slot Configuration | `backend/src/ai/router/config.ts` | Lines 1–27 | Hardcodes `fast`, `general`, and `reasoning` to `gemini` (`gemini-3.6-flash`) |
| **Google Gemini** | Gateway Provider Factory | `backend/src/ai/router/index.ts` | Lines 15–24 | Instantiates `GeminiProvider(config.GOOGLE_AI_API_KEY)` |
| **Google Gemini** | Health Check Probes | `backend/src/shared/health.service.ts` | Lines 238–251 | Native `fetch` probe to `https://generativelanguage.googleapis.com/v1beta/models?key=...` |
| **Google Gemini** | Frontend Client WebSocket | `frontend/src/services/geminiLiveClient.ts` | Lines 1–268 | Connects to `/api/v1/voice/live` expecting Gemini Live protocol |
| **Google Gemini** | Frontend Modular Voice Engine | `frontend/src/services/voiceEngine.ts` | Lines 1–370 | Orchestrates microphone capture for Gemini Multimodal Live streaming |
| **Google Gemini** | Frontend Live Voice Controller | `frontend/src/services/liveVoiceController.ts` | Lines 1–130 | State management adapter between VoiceStateMachine and GeminiLiveClient |
| **OpenAI** | Chat Completions | `backend/src/ai/providers/openai.provider.ts` | Lines 1–107 | Native `fetch` to `https://api.openai.com/v1/chat/completions` (model `gpt-4o-mini`) |
| **OpenAI** | Vector Embeddings | `backend/src/ai/embeddings/openai.embeddings.ts` | Lines 1–43 | Native `fetch` to `https://api.openai.com/v1/embeddings` (`text-embedding-3-small`, 1536 dim) |
| **OpenAI** | Embeddings Router | `backend/src/ai/embeddings/router.ts` | Lines 28–35 | Selects OpenAI if `OPENAI_API_KEY` is present |
| **OpenAI** | Health Check Probes | `backend/src/shared/health.service.ts` | Lines 222–236 | Probes `https://api.openai.com/v1/models` |
| **Anthropic** | Messages API | `backend/src/ai/providers/anthropic.provider.ts` | Lines 1–105 | Native `fetch` to `https://api.anthropic.com/v1/messages` (`claude-3-5-sonnet-20241022`) |
| **Anthropic** | Health Check Probes | `backend/src/shared/health.service.ts` | Lines 253–275 | Probes `https://api.anthropic.com/v1/messages` |

---

## C. All Online Model Calls and Their Purpose

Every cognitive operation in GIA currently routes through cloud LLMs:

```text
1. Intent Detection & Planning:
   └── Caller: AgentRouter.route() [backend/src/ai/orchestrator/router.ts:95-145]
       └── Purpose: Classifies input query into "direct_response", "memory_retrieval", "rag", "tool", or "multi_step"
       └── Target: LLMGateway.generate(..., { modelType: 'fast' }) -> Gemini 3.6 Flash (temperature: 0.0, JSON mode)

2. Response Generation (Synchronous Chat):
   └── Caller: ConversationService.sendMessageSync() [backend/src/conversations/services/conversation.service.ts:63]
       └── Purpose: Standard multi-turn conversational reply
       └── Target: LLMGateway.generate() -> Gemini 3.6 Flash

3. Response Generation (Streaming Chat):
   └── Caller: ConversationService.sendMessageStream() [backend/src/conversations/services/conversation.service.ts:102]
       └── Purpose: Real-time chunked token streaming to WebSocket client (/api/v1/chat/stream)
       └── Target: LLMGateway.stream() -> Gemini 3.6 Flash (SSE stream)

4. Agentic Workflow Execution:
   └── Caller: AgentOrchestrator.respondingNode() [backend/src/ai/orchestrator/orchestrator.ts:330]
       └── Purpose: Synthesizes final response incorporating RAG document chunks, memories, and tool outputs
       └── Target: LLMGateway.generate() -> Gemini 3.6 Flash

5. Multi-turn Agent Tool Selection Loop:
   └── Caller: Agent.runAgentLoop() [backend/src/ai/orchestrator/agent.ts:68]
       └── Purpose: Analyzes tool definitions and generates tool call JSON or final user answer
       └── Target: LLMGateway.generate() -> Gemini 3.6 Flash

6. RAG Grounding & Factual Synthesis:
   └── Caller: RAGService.sendMessageRAG() [backend/src/rag/services/rag.service.ts:125]
       └── Purpose: Generates cited answers strictly grounded in retrieved document chunks
       └── Target: LLMGateway.generate() -> Gemini 3.6 Flash

7. Semantic Memory Extraction:
   └── Caller: MemoryService.extractAndSaveFacts() [backend/src/memories/services/memory.service.ts:179]
       └── Purpose: Evaluates conversations and extracts long-term user preferences, facts, and episodic notes
       └── Target: LLMGateway.generate() -> Gemini 3.6 Flash (JSON extraction prompt)

8. Real-time Multimodal Voice Dialogue:
   └── Caller: GeminiLiveService.connect() & handleServerMessage() [backend/src/ai/services/geminiLive.service.ts:132]
       └── Purpose: Full duplex speech-to-speech dialogue, voice barge-in, and realtime voice tool invocation
       └── Target: Google Gemini Multimodal Live API (model: gemini-2.0-flash-exp, voice: Kore)

9. Dependency Health Probing:
   └── Caller: HealthService.probeLLMProvider() & probeOpenAI() & probeAnthropic() [backend/src/shared/health.service.ts]
       └── Purpose: Deep health checks for readiness probes (/api/v1/health/ready)
       └── Target: Google, OpenAI, Anthropic status endpoints
```

---

## D. All Existing Local Models and Their Locations

### 1. Downloaded Qwen 3.5 4B Weights (Target LLM)
*   **Prompt Stated Path:** `ai-service/models/Qwen/`
*   **Actual Verified Path on Disk:** `/Users/aftab/Desktop/GIA-AI/models/Qwen3.5-4b/`
*   **Directory Contents & File Inventory:**
    - `config.json` (3,161 bytes)
    - `model.safetensors-00001-of-00002.safetensors` (5,329,398,688 bytes / ~5.33 GB)
    - `model.safetensors-00002-of-00002.safetensors` (3,990,429,408 bytes / ~3.99 GB)
    - `model.safetensors.index.json` (76,196 bytes)
    - `tokenizer.json` (12,807,982 bytes / ~12.8 MB)
    - `tokenizer_config.json` (16,710 bytes)
    - `vocab.json` (6,722,759 bytes / ~6.72 MB)
    - `merges.txt` (3,353,259 bytes / ~3.35 MB)
    - `chat_template.jinja` (7,756 bytes)
    - `preprocessor_config.json` (390 bytes)
    - `video_preprocessor_config.json` (385 bytes)
    - `README.md` (77,661 bytes)
    - `LICENSE` (11,544 bytes)
    - `.gitattributes` (1,570 bytes)
*   **Model Architecture:** `Qwen3_5ForConditionalGeneration` (hybrid text architecture with 32 layers: 24 linear attention / Gated Delta Mamba SSM layers + 8 full self-attention layers, 2560 hidden dimension, 262k context window, plus vision encoder).

### 2. Models in `ai-service`
*   `models/STT/`: Directory exists at root, currently empty (0 bytes).
*   In Python code (`ai-service/app/core/config.py` in Git HEAD):
    - `STT_PROVIDER = "whisper"`: Configured for `faster-whisper` (`tiny` model on CPU/int8). Downloaded on-demand via Hugging Face Hub into `~/.cache/huggingface/hub/`.
    - `TTS_PROVIDER = "neural"`: Configured for `piper-en` or synthetic wave synthesis.
    - `EMBEDDING_MODEL = "text-embedding-3-small"` (dimension 1536).
    - `RERANKER_MODEL = "bge-reranker-base"`.

---

## E. Current STT / TTS Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                DUAL VOICE ARCHITECTURE                                │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│ Pipeline 1: Cloud Multimodal Live         │ Pipeline 2: Decoupled Local REST Engine    │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ • Entry: Frontend VoiceEngine             │ • Entry: Frontend VoiceStateMachine        │
│ • Capture: 16kHz S16LE PCM AudioWorklet   │ • Capture: MediaRecorder / AudioRecorder   │
│ • Transport: WebSocket /api/v1/voice/live │ • Transport: Multipart POST /voice/chat    │
│ • Cloud Server: Gemini Live API           │ • STT: Python Faster-Whisper (tiny/cpu)    │
│ • STT / TTS: End-to-End Gemini Neural     │ • Orchestrator: Node.js FSM Agent          │
│ • Output: 24kHz S16LE PCM chunks          │ • TTS: Python Piper-TTS (22.05kHz WAV)     │
│ • Playback: LiveAudioPlayer (Web Audio)   │ • Playback: DesktopAudioPlayer (HTMLAudio) │
└───────────────────────────────────────────┴────────────────────────────────────────────┘
```

### 1. Wake-Word Detection
*   **Historical:** Previously utilized an explicit "awake" keyword gate.
*   **Current State:** Removed in commit `23fc9b3` (`removed the awake keyword and now its working without awake keyword`). In `backend/src/api/routes/voice.ts:173`, incoming audio is directly transcribed and processed without keyword gating.

### 2. Continuous Listening & Audio Feedback Prevention
*   **Voice Activity Detection (VAD):** Handled entirely in the client using `LocalVAD` (`frontend/src/services/localVad.ts`), calculating RMS energy per audio frame.
*   **Echo / Audio Loop Prevention:** Implemented via strict state transitions in `VoiceStateMachine` (`frontend/src/services/voiceStateMachine.ts:102–136`):
    - In `LISTENING` or `SPEECH_DETECTED`: Mic capture is **active**, barge-in mode is disabled.
    - In `SYNTHESIZING` or `PLAYING`: Mic capture is **paused** (`onPauseCapture()`) and barge-in mode is enabled (`onSetBargeInMode(true)`).
    - In `IDLE`, `PROCESSING`, `TRANSCRIBING`: Mic capture is disabled.
*   **Barge-In Mechanism:** When audio is playing, `LocalVAD` elevates threshold from `0.015` to `0.045` and requires `200ms` of continuous loud speech. If detected, it immediately sends an interrupt signal, aborts active generation/playback, and switches state back to `LISTENING`.

---

## F. Current RAG and Embedding Architecture

### 1. Vector Database & Storage Schema
*   **Database:** PostgreSQL 17 + `pgvector` extension.
*   **Migration Files:**
    - `backend/src/database/migrations/001_initial_schema.sql`
    - `backend/src/database/migrations/004_vector_hnsw_indexes.sql`
*   **Vector Dimension:** Hardcoded to **`1536`** in:
    - `memories.embedding vector(1536)`
    - `document_chunks.embedding vector(1536)`
    - HNSW indexes: `idx_memories_embedding_hnsw` and `idx_document_chunks_embedding_hnsw` with cosine distance (`vector_cosine_ops`).

### 2. Embedding Generation Flow
*   `getEmbeddingProvider()` (`backend/src/ai/embeddings/router.ts`):
    - Priority 1: If `EMBEDDING_PROVIDER === 'python'` -> `PythonEmbeddingProvider` -> calls `POST http://127.0.0.1:8001/v1/embeddings/embed`.
    - Priority 2: In test mode -> `MockEmbeddingProvider` (returns 1536-dimensional mock vector).
    - Priority 3: If `OPENAI_API_KEY` present -> `OpenAIEmbeddingProvider` (calls OpenAI `text-embedding-3-small`, 1536-dim).
    - Priority 4: Fallback -> `PythonEmbeddingProvider`.

### 3. Retrieval & Reranking Flow
*   `RAGService.queryAndRetrieve()` (`backend/src/rag/services/rag.service.ts`):
    1. Embeds query via active embedding provider.
    2. Executes cosine similarity query in PostgreSQL for top `limit * 2` document chunks (`DocumentChunkRepository.searchSimilarChunks`).
    3. Calls Python AI Service `POST http://127.0.0.1:8001/v1/reranker/rerank` (`bge-reranker-base`) with query and retrieved candidate texts.
    4. Searches user preference memories semantically in PostgreSQL (`MemoryService.searchMemoriesSemantic`).
    5. Returns fused context chunks and memories to the caller.

### 4. Memory Architecture (3 Tiers)
*   Managed in `backend/src/memories/services/memory.service.ts`:
    - **Short-term Memory:** Active task context and conversational states.
    - **Long-term Semantic Memory:** Persisted user preferences and durable knowledge (stored with vector embeddings in `memories` table).
    - **Episodic Memory:** Architectural decisions and interaction milestones.
    - **Fact Extraction:** Evaluated asynchronously by `MemoryService.extractAndSaveFacts` via LLM prompt.

---

## G. Current Model Routing and Fallback Logic

*   **Router Configuration (`backend/src/ai/router/config.ts`):**
    ```typescript
    export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
    export const ROUTER_CONFIGS: Record<ModelType, ModelConfig> = {
      fast: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
      general: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
      reasoning: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
    };
    ```
*   **Provider Factory (`backend/src/ai/router/index.ts`):**
    - Ignores provider configuration in production/dev and unconditionally instantiates `GeminiProvider(config.GOOGLE_AI_API_KEY, modelName)`.
    - In test mode: Falls back to `MockProvider`.
*   **Fallback Logic:**
    - Retry wrapper (`backend/src/shared/retry.ts`): 3 retry attempts with exponential backoff for network/HTTP failures.
    - Rate limit fallback: If Gemini hits 429 / quota exhausted in test mode, falls back to `MockProvider`. In production, it rethrows an error.
    - Agent router fallback: In `backend/src/ai/orchestrator/router.ts:16`, if the routing LLM call fails or times out (5-second threshold), it falls back to `SAFE_FALLBACK_ROUTE` (`route: 'direct_response'`).

---

## H. All Dependencies That Will Need Modification

### 1. Node.js Backend (`backend/package.json`)
*   **Remove / Decouple:**
    - `@google/genai` (`^2.20.0`): Can be removed once Gemini Live and Generative Language API integrations are replaced.
*   **Configuration & Typings:**
    - Remove or make optional `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` in `backend/src/config/index.ts`.
    - Add local LLM service configuration (e.g., `LOCAL_LLM_URL=http://127.0.0.1:8001/v1/chat/completions` or `http://127.0.0.1:8000/v1`).

### 2. Python AI Service (`ai-service/requirements.txt`)
Existing in Git HEAD:
```text
fastapi>=0.110.0
uvicorn[standard]>=0.28.0
pydantic>=2.6.0
pydantic-settings>=2.2.0
python-dotenv>=1.0.0
python-multipart>=0.0.9
sentence-transformers>=2.6.0
transformers>=4.38.0
torch>=2.2.0
faster-whisper>=1.0.0
pytest>=8.0.0
httpx>=0.27.0
```
*   **Required Adjustments:**
    - `transformers`: Must be upgraded to support Qwen 3.5 (`transformers>=4.49.0` or git source / wheels matching `transformers_version: 4.57.0.dev0` in Qwen's config).
    - `accelerate>=0.34.0`: Required for multi-safetensor device map loading on Apple Silicon MPS.
    - `torch>=2.4.0`: Native Apple Silicon `arm64` build with MPS acceleration.
    - `mlx` / `mlx-lm` or `llama-cpp-python` (Alternative high-throughput inference engines on Apple Silicon, if chosen).

### 3. Environment Variables Across Services

| Variable | Location | Current Role | Future Status |
| :--- | :--- | :--- | :--- |
| `GOOGLE_AI_API_KEY` | `backend/.env`, `backend/.env.example` | Powers Gemini Live & GeminiProvider | Remove / Deprecate |
| `OPENAI_API_KEY` | `backend/.env.example` | Legacy OpenAI chat & embeddings | Remove / Deprecate |
| `ANTHROPIC_API_KEY` | `backend/.env.example` | Legacy Claude provider | Remove / Deprecate |
| `GIA_AI_SERVICE_URL` | `backend/.env` | Points to Python service (`http://127.0.0.1:8001`) | Keep & Expand |
| `EMBEDDING_PROVIDER` | Backend process env | Switches between python & openai | Set to `python` permanently |
| `VITE_BACKEND_URL` | `frontend/.env` | Points to Node.js backend (`http://127.0.0.1:5000`) | Keep |

---

## I. Potential Compatibility Issues with Qwen 3.5 4B & Existing Python Environment

### 1. Corrupted / Incompatible Virtual Environment
*   **Finding:** `ai-service/.venv` is completely inoperable on this macOS `arm64` machine.
*   **Evidence:** Shebang points to `#!/home/jasin/Desktop/GIA-AI/ai-service/.venv/bin/python3`, failing with:
    `zsh: bad interpreter: /home/jasin/Desktop/GIA-AI/ai-service/.venv/bin/python3: no such file or directory`.
*   **Resolution:** Recreate `.venv` cleanly using Homebrew Python 3.11 (`/opt/homebrew/bin/python3.11 -m venv ai-service/.venv`). Python 3.15 installed on this system is too experimental for PyTorch and Transformers C-extensions.

### 2. Missing `ai-service/app` in Working Tree
*   **Finding:** `git status` shows `ai-service/app/` files were deleted in the working tree.
*   **Resolution:** Files must be restored from Git HEAD (`git checkout HEAD -- ai-service/app ai-service/requirements.txt`) when migration begins.

### 3. Model Architecture & Transformers Version (`Qwen3_5ForConditionalGeneration`)
*   **Finding:** `config.json` declares:
    ```json
    "architectures": ["Qwen3_5ForConditionalGeneration"],
    "model_type": "qwen3_5",
    "transformers_version": "4.57.0.dev0"
    ```
*   **Impact:** Standard PyPI releases of `transformers` (e.g. 4.38 - 4.45) do not know about `qwen3_5` or its hybrid layer types (`linear_attention` / Mamba SSM + `full_attention`). Loading via `AutoModelForCausalLM` on older transformers will throw:
    `ValueError: The model class you are trying to instantiate does not seem to be configured in transformers`.
*   **Resolution:** In the migration plan, install `transformers` from the upstream master branch or specify `trust_remote_code=True` if modeling scripts are provided.

### 4. Apple Silicon (M1 Pro, 32GB RAM) Resource Envelope
*   **Memory Footprint:** 
    - Qwen 3.5 4B weights are **~9.32 GB** in `bfloat16`.
    - Apple M1 Pro has 32 GB unified memory.
    - MPS (`mps`) device allocation for 9.3 GB model leaves **>20 GB** headroom for macOS, PostgreSQL, Redis, Node.js Fastify, Faster-Whisper, and context KV cache.
    - Running bfloat16 locally without quantization is 100% feasible and optimal on this machine.

### 5. Multimodal Audio Gap (Qwen 3.5 4B is Vision-Language, Not Audio-to-Audio)
*   **Finding:** Qwen 3.5 4B accepts text and images/video (`image-text-to-text`). It **cannot** accept raw PCM audio frames or generate PCM audio directly.
*   **Impact on Gemini Live Replacement:** You cannot stream raw microphone audio directly into Qwen and receive synthetic audio back as was done with `@google/genai`.
*   **Resolution:** The voice pipeline must be converted into a pipelined local stack:
    `Microphone Audio -> Local STT (Faster-Whisper) -> Text Prompt -> Local Qwen 3.5 4B (Streaming) -> Local Speech Chunker -> Local TTS (Piper) -> Audio Playback`.

### 6. Vector Dimension Conflict (1536 vs 2560)
*   **Finding:** 
    - The PostgreSQL database schema has `embedding vector(1536)` hardcoded.
    - Qwen 3.5 4B has a hidden dimension of `2560` (`hidden_size: 2560`).
*   **Requirement:** If Qwen 3.5 4B is the *only* LLM and is also used to extract vector embeddings, PostgreSQL columns (`memories.embedding`, `document_chunks.embedding`) must be migrated from `vector(1536)` to `vector(2560)`. Alternatively, if embeddings use a small local embedding model, the user must clarify whether embedding models count under "Do not download another LLM".

---

## J. Recommended Migration Plan

### Phase 1: Environment Stabilization (Zero Code Breaking)
1. Restore `ai-service/app/` and `ai-service/requirements.txt` from Git HEAD.
2. Move `/Users/aftab/Desktop/GIA-AI/models/Qwen3.5-4b/` into `/Users/aftab/Desktop/GIA-AI/ai-service/models/Qwen3.5-4b/` (or create a symbolic link).
3. Rebuild `ai-service/.venv` using `/opt/homebrew/bin/python3.11`.
4. Install PyTorch with Apple Silicon MPS support and required Transformers version.

### Phase 2: Local Qwen 3.5 4B Inference Engine in Python Service
1. Create `ai-service/app/services/llm_service.py` wrapping Qwen 3.5 4B using PyTorch on `mps` with streaming token generation and chat template formatting.
2. Implement OpenAI-compatible endpoints on FastAPI:
   - `POST /v1/chat/completions` (supporting SSE text streaming and JSON structured outputs).
3. Add health and readiness check verification for the local model.

### Phase 3: Node.js Backend Integration
1. Implement `LocalQwenProvider` in `backend/src/ai/providers/qwen.provider.ts` implementing `LLMProvider`.
2. Update `ROUTER_CONFIGS` in `backend/src/ai/router/config.ts` to set `provider: 'qwen'` across all three slots (`fast`, `general`, `reasoning`).
3. Update `getProviderInstance` in `backend/src/ai/router/index.ts` to instantiate `LocalQwenProvider`.
4. Update `AgentRouter` to use the local Qwen provider for planning and intent detection.
5. Update `MemoryService` and `RAGService` to use Qwen for fact extraction and document RAG generation.

### Phase 4: Local Voice Architecture Unification
1. Replace `GeminiLiveService` in `backend/src/api/routes/voiceLive.ts`:
   - Keep the existing WebSocket protocol so frontend UI requires minimal disruption.
   - On the backend, wire incoming 16kHz PCM audio to Faster-Whisper STT -> feed transcript to Qwen 3.5 4B (streaming) -> feed text chunks to local Piper TTS -> stream 24kHz audio back to the client.
2. Refactor frontend `geminiLiveClient.ts` into a provider-agnostic `localVoiceClient.ts` (or preserve interface under existing name to protect frontend stability).

### Phase 5: Vector & Embedding Adaptation
1. If using Qwen 3.5 4B for embeddings: create a database migration `005_update_vector_dimensions_2560.sql` to resize `embedding vector(2560)`.
2. Point `PythonEmbeddingProvider` to the local AI service embedding endpoint.

### Phase 6: Test Suite & Deprecation Cleanup
1. Update backend unit/integration tests to mock or run against `LocalQwenProvider`.
2. Deprecate and remove `@google/genai` dependency and obsolete cloud API keys.

---

## K. Files That Need Modification, Removal, or Creation

### 1. Files to Create
*   `ai-service/app/services/llm_service.py`: Loads Qwen 3.5 4B on `mps` with text generation & streaming.
*   `ai-service/app/api/routes/llm.py`: Exposes `/v1/chat/completions` (OpenAI format) in FastAPI.
*   `backend/src/ai/providers/qwen.provider.ts`: Local Qwen LLM Provider for Node.js `LLMGateway`.
*   `backend/src/database/migrations/005_resize_vector_2560.sql` (if using Qwen hidden states for embeddings).

### 2. Files to Modify
*   `ai-service/requirements.txt`: Update PyTorch, Transformers, and acceleration libraries.
*   `ai-service/app/core/config.py`: Add Qwen model path and device settings (`mps`).
*   `ai-service/app/models/lifecycle.py`: Add Qwen model warmup and memory lifecycle management.
*   `backend/src/ai/router/config.ts`: Change model providers from `gemini` to `qwen`.
*   `backend/src/ai/router/index.ts`: Route provider instantiation to `LocalQwenProvider`.
*   `backend/src/config/index.ts`: Remove mandatory `GOOGLE_AI_API_KEY`, add local LLM config.
*   `backend/src/api/routes/voiceLive.ts`: Replace `GeminiLiveService` with local STT-LLM-TTS streaming engine.
*   `backend/src/shared/health.service.ts`: Replace Gemini/OpenAI/Anthropic probes with local LLM probe.
*   `frontend/src/App.tsx`: Update settings drawer labels (change "Gemini / OpenAI / Anthropic" to local Qwen profiles).
*   `frontend/src/services/voiceEngine.ts`: Update comments and configuration references from Gemini to local GIA engine.

### 3. Files to Remove / Retire (In Later Phase, Post-Approval)
*   `backend/src/ai/services/geminiLive.service.ts`: Google Gemini Multimodal Live API client.
*   `backend/src/ai/services/geminiStream.service.ts`: Replaced by standard local token stream chunker.
*   `backend/src/ai/providers/gemini.provider.ts`: Obsolete Google Generative Language client.
*   `backend/src/ai/providers/openai.provider.ts`: Obsolete OpenAI client.
*   `backend/src/ai/providers/anthropic.provider.ts`: Obsolete Anthropic client.
*   `backend/src/ai/embeddings/openai.embeddings.ts`: Obsolete OpenAI embedding client.

