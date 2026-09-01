# 🧠 GIA — Global Intelligence Assistant

<div align="center">

![GIA Assistant Banner](https://img.shields.io/badge/GIA-AI%20Assistant-6366f1?style=for-the-badge&logo=openai&logoColor=white)

**An intelligent, stateful desktop AI assistant powered by multi-LLM orchestration, real-time voice loops, semantic memory RAG, and native desktop integration.**

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

## 🚀 Key Features

- 🎙️ **Real-Time Voice Pipeline**: Full-duplex voice interactions with stateful voice state management, STT (Speech-to-Text), TTS (Text-to-Speech), native mic capture via Rust/Tauri, and audio playback.
- 🧠 **Episodic & Semantic Memory**: Long-term memory store powered by PostgreSQL + `pgvector` for context-aware conversation retrieval over time.
- 🔀 **Multi-LLM Model Router**: Dynamic, fault-tolerant routing between OpenAI, Anthropic, and Google Gemini models.
- 📚 **Document RAG System**: Smart document parsing, chunking, vector embedding, and hybrid retrieval.
- 🖥️ **Cross-Platform Desktop Shell**: Native desktop application wrapper built with Rust and Tauri for OS-level integrations.
- ⚡ **High-Performance Microservices**: Decoupled Node.js Fastify backend and FastAPI Python ML service.

---

## 🏗️ System Architecture

```mermaid
graph TD
    User([User Interface]) <--> Tauri["Tauri Desktop Shell (Rust)"]
    Tauri <--> React["React UI (Vite / Tailwind CSS)"]
    React <-->|HTTP / WebSockets| Fastify["Fastify API Backend (Node.js / TS)"]
    
    subgraph Backend ["GIA Node.js Backend"]
        Fastify <--> Orch["AI Orchestrator"]
        Orch <--> Router["Model Router"]
        Orch <--> Memory["Memory Service"]
        Orch <--> RAG["RAG Service"]
        Orch <--> Tools["Tool Execution"]
        
        Router <--> OpenAI["OpenAI API"]
        Router <--> Anthropic["Anthropic API"]
        Router <--> Gemini["Gemini API"]
    end
    
    subgraph Data ["Data Layer"]
        Memory <--> DB[("PostgreSQL + pgvector")]
        RAG <--> DB
        Fastify <--> Redis[("Redis Sessions")]
    end
    
    subgraph PythonService ["AI Python ML Service"]
        Orch <--> PyService["FastAPI ML Service (TTS, STT, Embeddings)"]
    end
```

---

## 🛠️ Tech Stack

| Component | Technologies & Frameworks |
| :--- | :--- |
| **Desktop Shell** | [Tauri](https://tauri.app/) (Rust) |
| **Frontend UI** | [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/) |
| **Core API Backend** | [Node.js](https://nodejs.org/), [Fastify](https://www.fastify.io/), [TypeScript](https://www.typescriptlang.org/), [LangChain](https://js.langchain.com/) |
| **AI / ML Service** | [Python 3.10+](https://www.python.org/), [FastAPI](https://fastapi.tiangolo.com/), [PyTorch](https://pytorch.org/) |
| **Database & Vectors** | [PostgreSQL 16](https://www.postgresql.org/) with [`pgvector`](https://github.com/pgvector/pgvector) extension |
| **Session & Cache** | [Redis 7](https://redis.io/) |

---

## 💻 Prerequisites

Ensure you have the following installed on your machine before setup:

- **Node.js**: v18.x or v20.x
- **npm**: v9.x or higher
- **Python**: v3.10 or higher
- **Rust toolchain**: (for Tauri desktop builds) `rustc` & `cargo` ([Install Rust](https://www.rust-lang.org/tools/install))
- **Docker & Docker Compose**: (For running PostgreSQL + pgvector and Redis)

---

## 📦 Getting Started & Setup

Follow these steps to set up and run GIA locally:

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/your-username/GIA-AI.git
cd GIA-AI
```

### 2️⃣ Start Database Services (PostgreSQL + Redis)

Use Docker Compose to launch the vector database and cache store:

```bash
npm run db:up
```
*(This starts PostgreSQL with `pgvector` on port `5432` and Redis on port `6379`.)*

---

### 3️⃣ Set Up Environment Variables

Create `.env` configuration files in both `backend/` and `ai-service/`:

#### Backend Configuration (`backend/.env`):
```env
PORT=5000
HOST=0.0.0.0
DATABASE_URL=postgresql://gia_admin:gia_secure_pass@localhost:5432/gia_development
NODE_ENV=development
JWT_SECRET=your_secure_random_jwt_secret_at_least_32_chars
OPENAI_API_KEY=your_openai_api_key
GOOGLE_AI_API_KEY=your_gemini_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
REDIS_URL=redis://localhost:6379
SESSION_TTL_SECONDS=604800
```

---

### 4️⃣ Install Dependencies

#### Root & Node Services:
```bash
npm install
npm --prefix backend install
npm --prefix frontend install
```

#### Python ML Service:
```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

---

### 5️⃣ Launch Development Servers

You can start all microservices concurrently with a single command from the monorepo root:

```bash
npm run dev
```

This starts:
- 🔵 **Backend Fastify Service**: `http://localhost:5000`
- 🟡 **AI Python FastAPI Service**: `http://localhost:8001`
- 🟢 **Tauri Desktop Shell & React UI**: `http://localhost:1420`

---

## 📜 Monorepo Scripts Reference

Run these commands from the root directory:

| Command | Action |
| :--- | :--- |
| `npm run dev` | Launch all microservices (Backend, AI service, Tauri UI) concurrently |
| `npm run db:up` | Start PostgreSQL (`pgvector`) & Redis via Docker Compose |
| `npm run db:down` | Stop database containers |
| `npm run backend:dev` | Run Fastify backend in dev mode with auto-reload |
| `npm run backend:test` | Run Jest test suite for the backend |
| `npm run ai:dev` | Run Python FastAPI ML service on port `8001` |
| `npm run frontend:dev` | Start Vite React UI dev server |
| `npm run tauri:dev` | Launch desktop app using Tauri shell |
| `npm run build` | Build production bundles for backend and Tauri application |

---

## 📂 Project Directory Structure

```text
GIA-AI/
├── backend/                  # Core Node.js Fastify Application
│   ├── src/
│   │   ├── ai/               # Multi-LLM provider wrappers & model router
│   │   ├── api/              # HTTP routes, controllers, and middlewares
│   │   ├── auth/             # User auth & Redis session management
│   │   ├── database/         # Database pools, migrations, and repositories
│   │   ├── memories/         # Short-term, Long-term, and Episodic memory
│   │   └── rag/              # Vector document retrieval pipeline
│   └── tests/                # Jest integration and unit tests
│
├── frontend/                 # React UI + Tauri Desktop Application
│   ├── src/                  # React views, components, and state management
│   └── src-tauri/            # Rust native desktop shell configurations & audio capture
│
├── ai-service/               # Python ML API Microservice
│   ├── app/                  # FastAPI routers, TTS, STT, and embedding models
│   └── tests/                # Pytest unit and integration tests
│
├── docker-compose.yml        # Infrastructure service stack (Postgres + Redis)
├── package.json              # Monorepo root package configuration
└── README.md                 # Project documentation
```

---

## 🧪 Testing

### Backend Unit & Integration Tests:
```bash
npm run backend:test
```

### Python ML Service Tests:
```bash
cd ai-service
.venv/bin/pytest
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
