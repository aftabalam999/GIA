# 🧠 GIA — General Intelligent Assistant

<div align="center">

![GIA AI Banner](https://img.shields.io/badge/GIA-Autonomous%20Desktop%20Assistant-6366f1?style=for-the-badge&logo=ai&logoColor=white)

**An autonomous, privacy-first desktop AI assistant powered by local Qwen 3.5 4B, continuous voice streaming, local semantic RAG, and a mandatory Plan-First safety architecture.**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![Tauri](https://img.shields.io/badge/Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-202020?style=for-the-badge&logo=fastify&logoColor=white)](https://www.fastify.io/)
[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

</div>

---

## 🌟 Overview

GIA (**General Intelligent Assistant**) is a secure, local-first desktop AI agent designed to interact with your operating system safely. Built from the ground up on Apple Silicon / local hardware, GIA combines local deep learning models with a **mandatory Plan-First execution architecture**: GIA **never executes actions immediately** without presenting a structured, dependency-ordered plan and obtaining explicit user approval.

---

## 🛡️ Core Innovation: The Plan-First Architecture

Every actionable user instruction (whether received via text or voice) follows an unbreakable security lifecycle:

```mermaid
flowchart TD
    A["👤 User Instruction\n('Open YouTube in Chrome')"] --> B["🧠 Intent Understanding & Classification"]
    B -->|Conversational / Chit-chat| C["💬 Direct Local LLM Reasoning"]
    B -->|Actionable Instruction| D["📋 Task Planning Engine\n(Qwen 3.5 4B / Deterministic)"]
    D --> E["🔍 Strict Zod Schema Validation"]
    E --> F["🖥️ Present Plan Card to User\n(Steps, Targets, Risk Levels)"]
    F --> G{"⏳ Centralized Permission Gate\n(Wait for Human Approval)"}
    G -->|User: 'Approved' / 'Proceed'| H["🎟️ Issue Cryptographic Execution Ticket"]
    G -->|User: 'Cancel' / 'Reject'| I["🛑 Invalidate & Cancel Plan"]
    G -->|User: 'Modify' / 'Also add step'| J["✏️ Formulate Plan Revision (Revoke Ticket)"]
    H --> K["⚙️ Approved Plan Execution Engine"]
    K --> L["🔧 12 Allowlisted Core Tools\n(Dependency Order & Verification)"]
    L --> M["📊 Verify Step Results & Audit Log"]
    M --> N["✅ Report Results to Desktop UI"]
```

### 1. Mandatory Approval Gate
- **Zero Immediate Tool Execution**: Tools, shell commands, and filesystem modifications cannot run from raw natural language input.
- **Cryptographic Execution Tickets**: Execution tickets have single-use step consumption, cryptographic UUID validation, and strict expiration windows.
- **Permission States**: Full state-machine tracking: `awaiting_approval`, `pending`, `approved`, `rejected`, `modified`, `expired`, `executing`, `completed`, `failed`, and `cancelled`.

### 2. Centralized Allowlisted Tool Registry
GIA contains 12 core desktop tools, each strictly isolated with Zod schemas, timeout enforcement, risk levels, and post-execution verification:
1. `launch_application`: Opens desktop applications on macOS/Linux with process ID verification.
2. `close_application`: Gracefully quits or terminates running processes with verification.
3. `navigate_browser`: Navigates browsers to verified HTTP/HTTPS destinations.
4. `search_browser`: Dispatches search queries to Google, YouTube, or GitHub.
5. `create_file`: Writes files strictly restricted to authorized workspace boundaries.
6. `read_file`: Reads files safely with path-traversal prevention.
7. `update_file`: Modifies or appends file content with boundary checks.
8. `delete_file`: Safely unlinks files with post-deletion verification.
9. `open_folder`: Resolves local paths and opens folders in native desktop file managers.
10. `execute_terminal_command`: Runs allowlisted terminal commands with argument sanitization.
11. `capture_screen`: Takes desktop screenshots with file-save confirmation.
12. `interact_with_application`: Activates or hides desktop application windows.

---

## ⚡ 100% Local AI Stack (Zero Cloud Dependency)

GIA runs entirely on your local machine with zero external API calls:

- **Local LLM**: [Qwen 3.5 4B](https://huggingface.co/Qwen/Qwen2.5-Coder-7B) running locally via PyTorch with Apple Silicon Metal Performance Shaders (MPS) hardware acceleration.
- **Local Speech-to-Text**: [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) (Tiny, Int8 quantized) providing low-latency transcription.
- **Local Text-to-Speech**: Native macOS speech synthesis (`say`) delivering instant audio playback.
- **Local Embeddings**: `sentence-transformers/all-MiniLM-L6-v2` (384-dimensional vectors) with local HNSW indexing in PostgreSQL (`pgvector`).
- **Local Reranker**: `BAAI/bge-reranker-base` for semantic chunk reranking.
- **Continuous Voice Mode**: Native Rust audio capture, local Silero VAD (Voice Activity Detection), wake-word detection ("Hey GIA"), and natural voice barge-in interruption.

---

## 🏗️ Technical Architecture

| Component | Technologies | Port / Role |
| :--- | :--- | :--- |
| **Desktop Shell** | [Tauri](https://tauri.app/) (Rust) | Native window management, low-level microphone capture, and OS bridges |
| **Frontend UI** | [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/) | Single unified conversational interface with real-time `PlanCard` controls |
| **Fastify Backend** | [Node.js](https://nodejs.org/) v20+, [TypeScript](https://www.typescriptlang.org/), [Fastify](https://www.fastify.io/) | Port `5001`: Planning Engine, Permission Gate, Plan Execution Engine |
| **Python AI Service** | [Python 3.11](https://www.python.org/), [FastAPI](https://fastapi.tiangolo.com/), [PyTorch MPS](https://pytorch.org/) | Port `8001`: Qwen 3.5 4B inference, Faster-Whisper, and vector embeddings |
| **Database** | [PostgreSQL 16](https://www.postgresql.org/) with [`pgvector`](https://github.com/pgvector/pgvector) | Port `5432`: Task plans, execution audit logs, episodic memories, and chunks |
| **Cache & Sessions** | [Redis 7](https://redis.io/) | Port `6379`: User session authentication and execution locks |

---

## 🚀 Getting Started

### Prerequisites

Ensure you have installed:
- **Node.js**: v18+ or v20+
- **Python**: v3.11 with `pip`
- **Rust & Cargo**: Latest stable ([rustup.rs](https://rustup.rs))
- **Docker & Docker Compose**: (For PostgreSQL + `pgvector` and Redis)

---

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/your-username/GIA-AI.git
cd GIA-AI
```

### 2️⃣ Start Database Services (PostgreSQL + Redis)

```bash
npm run db:up
```
*(Starts PostgreSQL with `pgvector` on port `5432` and Redis on port `6379`.)*

### 3️⃣ Configure Environment Variables

Create `backend/.env` (see `backend/.env.example`):

```env
PORT=5001
HOST=0.0.0.0
DATABASE_URL=postgresql://gia_admin:gia_secure_pass@localhost:5432/gia_development
NODE_ENV=development
JWT_SECRET=replace_with_a_secure_random_jwt_secret_key_32_chars
REDIS_URL=redis://localhost:6379
SESSION_TTL_SECONDS=604800
AI_SERVICE_URL=http://127.0.0.1:8001
```

### 4️⃣ Install Dependencies

```bash
# Node monorepo packages
npm install
npm --prefix backend install
npm --prefix frontend install

# Python AI Service
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..
```

---

### 5️⃣ Run GIA Locally

Launch all microservices concurrently:

```bash
npm run dev
```

Or run services individually:

```bash
# Terminal 1: Python AI Service (Qwen 3.5 4B & Whisper)
npm run ai:dev

# Terminal 2: Fastify Backend (Port 5001)
npm run backend:dev

# Terminal 3: Tauri Desktop Shell + React UI
npm run tauri:dev
```

---

## 🧪 Testing & Verification

GIA includes an exhaustive test suite covering all architectural phases:

```bash
# Run all backend unit, integration, and security tests
npm run backend:test
```

### Test Suite Highlights (277/277 Tests Passing):
- **Phase 1 (Task Planning Engine)**: 16 tests verifying atomic decomposition, dependency ordering, deterministic planning, and clarification triggers.
- **Phase 2 (Permission Manager)**: 24 tests verifying tickets, state transitions, expiration, and sensitivity confirmations.
- **Phase 3 (Plan Execution Engine)**: 24 tests verifying tool allowlists, verification logic, honest failure reporting, and dependency halting.
- **Phase 4 (Plan & Approval UI)**: 11 tests verifying UI state synchronization, approval triggers, and cancellation.
- **Phase 5 (Security Audit)**: 12 tests verifying zero unauthorized execution, injection prevention, and shell isolation.

---

## 🔒 Security Audit Summary

See [`reports/PHASE_5_SECURITY_AUDIT.md`](file:///Users/aftab/Desktop/GIA-AI/reports/PHASE_5_SECURITY_AUDIT.md) for the complete security verification report:

| Security Vector | Status | Verification Evidence |
| :--- | :---: | :--- |
| **Execution Without Approval** | 🛡️ **BLOCKED** | Gate rejects unapproved execution with `PERMISSION_DENIED` |
| **Direct Shell Command Injection** | 🛡️ **BLOCKED** | Dangerous commands (e.g. `rm -rf`, chained `;`, `&&`) rejected |
| **Frontend Authorization Bypass** | 🛡️ **BLOCKED** | Backend gate requires valid cryptographic tickets; frontend cannot bypass |
| **Self-Approval by LLM** | 🛡️ **BLOCKED** | System prompts and approval gate enforce explicit human identity |
| **Audio Loop Injection** | 🛡️ **BLOCKED** | Assistant synthesized speech flagged as non-user; cannot approve plans |
| **Sensitive Operation Escalation** | 🛡️ **BLOCKED** | Destructive actions require additional step-specific confirmation |

---

## 📜 Monorepo Scripts Reference

| Command | Action |
| :--- | :--- |
| `npm run dev` | Launch all microservices (Backend, AI service, Tauri UI) concurrently |
| `npm run db:up` | Start PostgreSQL (`pgvector`) & Redis via Docker Compose |
| `npm run db:down` | Stop database containers |
| `npm run backend:dev` | Run Fastify backend in dev mode with auto-reload (port `5001`) |
| `npm run backend:test` | Run the Vitest test suite (277 tests across 30 suites) |
| `npm run ai:dev` | Run Python FastAPI ML service with Qwen MPS acceleration (port `8001`) |
| `npm run frontend:dev` | Start Vite React UI dev server (port `1420`) |
| `npm run tauri:dev` | Launch desktop app using Tauri native shell |
| `npm run build` | Build production bundles for backend and Tauri desktop app |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
