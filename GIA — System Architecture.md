# GIA — System Architecture

> **Version:** V1  
> **Status:** Active  
> **Document:** `ARCHITECTURE.md`  
> **Purpose:** Architectural source of truth for GIA and AI coding agents.

---

## 1. What is GIA?

GIA is a personal AI assistant built around:

- Multiple LLM providers
- Intelligent model routing
- Short-term conversational context
- Long-term semantic memory
- Episodic memory
- Retrieval-Augmented Generation (RAG)
- Tool/function execution
- Agentic workflows
- Persistent conversations
- Document knowledge
- Streaming responses
- Desktop interaction through Tauri

GIA is **not** simply a chat application connected to an LLM.

The LLM is one component of the system.

The core of GIA is the **AI orchestration layer**, which coordinates models, memory, RAG, tools, conversations, and application state.

---

# 2. Core Architecture

```text
                         ┌──────────────────┐
                         │       USER       │
                         └────────┬─────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │     Tauri Desktop       │
                    │                         │
                    │ React + TypeScript      │
                    └────────────┬────────────┘
                                 │
                         HTTP / WebSocket
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │      GIA Backend        │
                    │                         │
                    │ Node.js + TypeScript    │
                    │ Fastify                 │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    AI ORCHESTRATOR      │
                    │                         │
                    │ Intent                  │
                    │ Context                 │
                    │ Planning                │
                    │ Model Selection         │
                    │ Tool Coordination       │
                    └───────┬───────┬─────────┘
                            │       │
                ┌───────────┘       └────────────┐
                ▼                                ▼
       ┌──────────────────┐             ┌──────────────────┐
       │  MEMORY SYSTEM   │             │   TOOL SYSTEM    │
       │                  │             │                  │
       │ Short-term       │             │ Web Search       │
       │ Long-term        │             │ Browser          │
       │ Semantic         │             │ File System      │
       │ Episodic         │             │ Code             │
       └────────┬─────────┘             │ External APIs    │
                │                       └────────┬─────────┘
                ▼                                │
       ┌──────────────────┐                       │
       │   RAG SYSTEM     │                       │
       │                  │                       │
       │ Retrieval        │                       │
       │ Embeddings       │                       │
       │ Re-ranking       │                       │
       │ Context          │                       │
       └────────┬─────────┘                       │
                │                                │
                └────────────────┬───────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │      MODEL ROUTER       │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐       ┌──────────┐       ┌──────────┐
        │  OpenAI  │       │Anthropic │       │  Gemini  │
        └──────────┘       └──────────┘       └──────────┘
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 ▼
                         ┌──────────────┐
                         │   RESPONSE   │
                         └──────┬───────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │       DATA LAYER        │
                    │                         │
                    │ PostgreSQL              │
                    │ pgvector                │
                    │ Cloudinary              │
                    └─────────────────────────┘
```

---

# 3. Architectural Philosophy

GIA follows this architecture:

```text
UI
 ↓
API
 ↓
Orchestrator
 ↓
Context + Memory + RAG + Tools
 ↓
Model Router
 ↓
LLM
 ↓
Response
```

The responsibilities are strictly separated.

| Component | Responsibility |
|---|---|
| Tauri | Desktop runtime |
| React | User interface |
| Fastify | API and transport |
| Orchestrator | AI workflow coordination |
| Model Router | Select appropriate LLM |
| Memory | Persistent user/context knowledge |
| RAG | External/document knowledge retrieval |
| Tools | External capabilities |
| PostgreSQL | Persistent application data |
| pgvector | Vector similarity search |
| Cloudinary | File/object storage |

---

# 4. Technology Stack

## Frontend

```text
Tauri
React
TypeScript
Tailwind CSS
```

### Tauri

Tauri provides the desktop application shell and native system integration.

### React

React is responsible only for UI and frontend state.

### TypeScript

TypeScript is mandatory throughout the frontend.

---

# 5. Backend

```text
Node.js
TypeScript
Fastify
WebSocket
```

Fastify is responsible for:

- HTTP API
- WebSocket connections
- authentication middleware
- request validation
- response streaming
- API versioning

The backend is initially a **modular monolith**.

Do not introduce microservices in V1.

---

# 6. AI Framework

GIA uses:

```text
LangChain
LangGraph
```

## LangChain

Use LangChain for:

- LLM integrations
- embedding models
- retrievers
- prompts
- tools
- model abstractions
- structured output

## LangGraph

Use LangGraph for:

- stateful agent workflows
- multi-step execution
- branching
- retries
- tool loops
- checkpoints
- human approval
- complex agent workflows

Do not use LangGraph for every request.

Simple requests should use a lightweight execution path.

---

# 7. AI Orchestrator

The orchestrator is the central component of GIA.

```text
User Request
     │
     ▼
Intent Analysis
     │
     ▼
Context Requirements
     │
     ├── Memory?
     │
     ├── RAG?
     │
     ├── Tools?
     │
     └── Reasoning?
     │
     ▼
Model Selection
     │
     ▼
Execution
     │
     ▼
Response
```

The orchestrator decides:

1. What the user wants.
2. What context is required.
3. Whether memory is required.
4. Whether RAG is required.
5. Whether tools are required.
6. Which model should be used.
7. Whether an agent workflow is required.
8. How the response should be generated.
9. What information should be persisted afterward.

---

# 8. Request Execution Paths

Not every request follows the same execution path.

## Simple Request

```text
User
 ↓
API
 ↓
Orchestrator
 ↓
Model Router
 ↓
LLM
 ↓
Response
```

Example:

```text
"What is 25 × 42?"
```

No memory or RAG retrieval should occur.

---

## Memory Request

```text
User
 ↓
Orchestrator
 ↓
Memory Retrieval
 ↓
Context Builder
 ↓
LLM
 ↓
Response
```

Example:

```text
"What database did I choose for GIA?"
```

---

## RAG Request

```text
User
 ↓
Orchestrator
 ↓
RAG Retrieval
 ↓
Relevant Chunks
 ↓
Context Builder
 ↓
LLM
 ↓
Response
```

Example:

```text
"According to my architecture document,
why did I choose PostgreSQL?"
```

---

## Tool Request

```text
User
 ↓
Orchestrator
 ↓
Tool Selection
 ↓
Tool Execution
 ↓
Tool Result
 ↓
LLM
 ↓
Response
```

Example:

```text
"Search the web for the latest LangGraph release."
```

---

## Complex Agent Request

```text
User
 ↓
Orchestrator
 ↓
LangGraph
 ↓
Planning
 ↓
Tools
 ↓
Memory/RAG
 ↓
Reasoning Model
 ↓
Validation
 ↓
Response
```

Example:

```text
"Analyze my project and find why the backend is slow."
```

---

# 9. Multi-LLM Architecture

GIA must not be coupled to one provider.

```text
                    MODEL ROUTER
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
     OpenAI          Anthropic          Gemini
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
                   Local Models
```

The rest of the application communicates with an internal abstraction.

```ts
interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResponse>;

  stream(
    request: LLMRequest
  ): AsyncIterable<LLMChunk>;
}
```

Provider-specific SDKs must remain inside the provider layer.

---

# 10. Model Router

The model router chooses the most appropriate model.

Factors may include:

- complexity
- reasoning requirements
- latency
- context size
- tool requirements
- model availability
- cost
- user preferences

Example:

```text
Simple calculation
        ↓
Fast model

Normal conversation
        ↓
General model

Complex code analysis
        ↓
Reasoning model
```

Do not hard-code model names throughout the application.

Use configuration.

---

# 11. Conversation System

Conversation history and memory are different systems.

## Conversation

Answers:

> What happened in this conversation?

## Memory

Answers:

> What should GIA remember beyond this conversation?

Architecture:

```text
User
 │
 ├── Conversations
 │      │
 │      └── Messages
 │
 └── Memories
```

Conversation data belongs in PostgreSQL.

---

# 12. Memory Architecture

GIA uses multiple memory types.

```text
                    MEMORY
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   Short-Term      Long-Term       Episodic
        │              │              │
        ▼              ▼              ▼
   Current Task    User Facts     Important Events
   Conversation    Preferences    Past Decisions
   Recent Context  Knowledge      Significant Actions
```

---

# 13. Short-Term Memory

Short-term memory represents the current conversational state.

Contains:

- recent messages
- current task
- active tool results
- temporary context
- current agent state

Storage:

```text
PostgreSQL
```

Do not continuously send the entire conversation to the LLM.

---

# 14. Long-Term Semantic Memory

Long-term memory contains durable information.

Examples:

```text
User prefers TypeScript.

User is building GIA.

User prefers PostgreSQL.

User uses Tauri for desktop applications.
```

Memory should contain structured information plus embeddings.

Example schema:

```text
Memory
├── id
├── user_id
├── type
├── content
├── importance
├── confidence
├── embedding
├── metadata
├── created_at
└── updated_at
```

---

# 15. Episodic Memory

Episodic memory represents important historical events.

Example:

```text
GIA Architecture Decision

The user decided to use PostgreSQL
with pgvector for V1 persistence
and semantic retrieval.
```

Episodes should only be created when they are likely to be useful later.

---

# 16. Neural Networks and Memory

Neural networks are **not the memory database**.

Do not train a neural network whenever the user says something.

Neural models are used for:

```text
Embedding generation
Semantic similarity
Memory extraction
Memory classification
Importance scoring
Memory consolidation
```

Persistent memory is stored in PostgreSQL.

Architecture:

```text
User Message
     │
     ▼
Memory Extraction
     │
     ▼
Candidate Memory
     │
     ▼
Importance / Confidence
     │
     ▼
Embedding
     │
     ▼
PostgreSQL + pgvector
```

---

# 17. Memory Write Policy

GIA must not remember everything.

Before storing memory, evaluate:

```text
Relevance
Durability
Importance
Confidence
Duplication
Sensitivity
Expiration
```

Example:

```text
"I am eating pizza."

→ Ignore.

"I prefer PostgreSQL for backend projects."

→ Store.

"My temporary server is running on port 5000."

→ Usually ignore as long-term memory.
```

---

# 18. RAG Architecture

RAG provides knowledge grounding.

Document ingestion:

```text
Document
   │
   ▼
Parser
   │
   ▼
Chunking
   │
   ▼
Embedding
   │
   ▼
PostgreSQL + pgvector
```

Query:

```text
User Query
   │
   ▼
Query Embedding
   │
   ▼
Vector Search
   │
   ▼
Relevant Chunks
   │
   ▼
Re-ranking
   │
   ▼
Context Builder
   │
   ▼
LLM
```

---

# 19. RAG and Memory Separation

Memory and RAG must remain separate.

### Memory

```text
"What does GIA know about me?"
```

### RAG

```text
"What does my document say?"
```

They may be used together.

Example:

```text
User:
"Based on my architecture document and
what you remember about my decisions,
explain why we chose PostgreSQL."
```

Execution:

```text
Memory
   +
RAG
   ↓
Context Builder
   ↓
LLM
```

---

# 20. Vector Storage

V1 uses:

```text
PostgreSQL
+
pgvector
```

Do not introduce a dedicated vector database unless scale or requirements justify it.

Potential future option:

```text
Pinecone
Qdrant
Weaviate
```

These are V2+ considerations.

---

# 21. Document Storage

V1 uses Cloudinary for object/file storage.

```text
              Cloudinary
                  │
                  ▼
             Actual File

              PostgreSQL
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      user_id   file_id   metadata
```

PostgreSQL stores metadata and references.

Large binary files should not be stored directly inside normal PostgreSQL rows.

---

# 22. Tool System

Tools provide capabilities that the LLM does not inherently possess.

```text
                    TOOL REGISTRY
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   Web Search        File System       Code
        │                │                │
        ▼                ▼                ▼
    Browser          Database       External APIs
```

Each tool must expose a controlled interface.

```ts
interface Tool {
  name: string;
  description: string;
  schema: unknown;

  execute(
    input: unknown
  ): Promise<unknown>;
}
```

The LLM requests a tool.

The backend validates it.

The backend executes it.

The result is returned to the agent.

The LLM must never receive unrestricted system access.

---

# 23. Tool Permissions

Tools must have permission levels.

```text
READ
WRITE
EXECUTE
DESTRUCTIVE
```

Examples:

```text
Read file
→ READ

Create file
→ WRITE

Run shell command
→ EXECUTE

Delete repository
→ DESTRUCTIVE
```

Destructive operations require explicit user authorization.

---

# 24. Agent Architecture

LangGraph is responsible for complex stateful workflows.

Example:

```text
                  USER REQUEST
                       │
                       ▼
                 Intent Node
                       │
                       ▼
                Context Node
                 /         \
                /           \
          Memory             RAG
             │                │
             └───────┬────────┘
                     ▼
                  Planning
                     │
                     ▼
                 Tool Node
                     │
              ┌──────┴──────┐
              │             │
           Success        Failure
              │             │
              │          Retry/Recover
              │             │
              └──────┬──────┘
                     ▼
                Response Node
                     │
                     ▼
                   Output
```

Application logic must remain deterministic wherever possible.

Do not allow the LLM to control the entire application.

---

# 25. Backend Structure

Recommended V1 structure:

```text
backend/
│
├── src/
│   │
│   ├── api/
│   │   ├── routes/
│   │   ├── controllers/
│   │   └── middleware/
│   │
│   ├── ai/
│   │   ├── orchestrator/
│   │   ├── agents/
│   │   ├── prompts/
│   │   ├── router/
│   │   ├── providers/
│   │   └── schemas/
│   │
│   ├── memory/
│   │   ├── extraction/
│   │   ├── retrieval/
│   │   ├── consolidation/
│   │   └── services/
│   │
│   ├── rag/
│   │   ├── ingestion/
│   │   ├── retrieval/
│   │   ├── chunking/
│   │   └── embeddings/
│   │
│   ├── tools/
│   │   ├── registry/
│   │   ├── web/
│   │   ├── filesystem/
│   │   ├── code/
│   │   └── system/
│   │
│   ├── conversations/
│   │   ├── services/
│   │   └── repositories/
│   │
│   ├── documents/
│   │   ├── services/
│   │   └── repositories/
│   │
│   ├── database/
│   │   ├── schema/
│   │   ├── migrations/
│   │   └── client/
│   │
│   ├── config/
│   ├── shared/
│   └── server.ts
│
└── tests/
```

---

# 26. Frontend Structure

```text
frontend/
│
├── src/
│   │
│   ├── components/
│   │
│   ├── features/
│   │   ├── chat/
│   │   ├── conversations/
│   │   ├── memory/
│   │   ├── documents/
│   │   └── settings/
│   │
│   ├── hooks/
│   ├── services/
│   ├── stores/
│   ├── types/
│   ├── utils/
│   └── App.tsx
│
└── src-tauri/
```

Use feature-oriented organization.

Do not create one giant `components/` directory containing the entire application.

---

# 27. API Architecture

API prefix:

```text
/api/v1
```

Examples:

```text
POST   /api/v1/conversations
GET    /api/v1/conversations
GET    /api/v1/conversations/:id

POST   /api/v1/conversations/:id/messages

POST   /api/v1/chat
WS     /api/v1/chat/stream

GET    /api/v1/memories
GET    /api/v1/memories/:id
DELETE /api/v1/memories/:id

POST   /api/v1/documents
GET    /api/v1/documents
GET    /api/v1/documents/:id
DELETE /api/v1/documents/:id
```

REST is used for normal application operations.

WebSocket is used for streaming and realtime interactions.

---

# 28. Database Architecture

Primary database:

```text
PostgreSQL
```

Vector extension:

```text
pgvector
```

Core entities:

```text
users
conversations
messages
memories
memory_embeddings
documents
document_chunks
tool_calls
agent_runs
model_runs
```

Relationships:

```text
User
 │
 ├── Conversations
 │       │
 │       └── Messages
 │
 ├── Memories
 │
 └── Documents
         │
         └── Document Chunks
```

---

# 29. Redis

Redis is optional in V1.

Use it only when an actual requirement exists.

Potential uses:

```text
Caching
Rate limiting
Distributed locks
Temporary agent state
Job queues
Session coordination
```

Redis must never replace PostgreSQL as the primary persistent datastore.

---

# 30. Context Management

Never send the entire conversation to the LLM indefinitely.

Context should be constructed from:

```text
Recent Messages
        +
Conversation Summary
        +
Relevant Memory
        +
Relevant RAG Chunks
        +
Tool Results
        +
Current User Request
```

Example:

```text
100-message conversation

        ↓

Recent 10 messages
        +
Summary of previous messages
        +
Relevant memories
        +
Relevant documents
```

The context builder owns this logic.

---

# 31. Prompt Architecture

Prompts must not be scattered throughout controllers.

Recommended structure:

```text
ai/prompts/

├── system/
├── memory/
├── rag/
├── tools/
└── agents/
```

Prompt construction should be explicit.

Conceptually:

```text
SYSTEM INSTRUCTIONS
        +
USER CONTEXT
        +
RELEVANT MEMORY
        +
RAG CONTEXT
        +
CONVERSATION CONTEXT
        +
AVAILABLE TOOLS
        +
CURRENT REQUEST
```

Do not inject unnecessary context.

---

# 32. Hallucination Control

RAG does not eliminate hallucination.

GIA should reduce hallucination using:

```text
1. Retrieval
2. Source grounding
3. Tool outputs
4. Model selection
5. Prompt constraints
6. Structured output validation
7. Confidence handling
8. Explicit uncertainty
```

When sufficient information is unavailable, GIA should say so rather than fabricate an answer.

---

# 33. Streaming Architecture

AI responses should be streamed.

```text
LLM
 │
 ▼
AI Orchestrator
 │
 ▼
Backend
 │
 │ token/chunk stream
 ▼
WebSocket
 │
 ▼
Tauri
 │
 ▼
React
 │
 ▼
Chat UI
```

The frontend should render partial responses as they arrive.

---

# 34. Background Processing

Long-running operations should eventually be moved to background workers.

Examples:

```text
Document parsing
Embedding generation
Memory extraction
Memory consolidation
Conversation summarization
Analytics
```

V1 may execute some operations synchronously.

However, service interfaces should allow them to become asynchronous later.

---

# 35. Observability

Every AI execution should be traceable.

At minimum track:

```text
request_id
user_id
conversation_id
agent_run_id
model
provider
latency
input_tokens
output_tokens
tool_calls
retrieval_count
errors
```

This should make it possible to answer:

```text
Why was this model selected?

Why did GIA hallucinate?

Which memory was retrieved?

Which RAG chunks were used?

Which tool failed?

How many tokens were consumed?
```

---

# 36. Error Handling

External dependencies are unreliable.

Possible failures:

```text
LLM unavailable
Embedding API unavailable
Database unavailable
Vector search failure
Tool timeout
Network timeout
Invalid tool arguments
Rate limit
Malformed model output
```

The architecture must support:

```text
Timeout
Retry
Fallback
Graceful failure
```

Example:

```text
OpenAI
   ↓
Unavailable
   ↓
LLM Gateway
   ↓
Fallback Provider
   ↓
Anthropic / Gemini
```

Fallback behavior must be configurable.

---

# 37. Security

Secrets must remain server-side.

Never expose:

```text
LLM API keys
Database credentials
Cloudinary secrets
Internal service credentials
```

Frontend code must never contain provider secrets.

Example environment configuration:

```text
DATABASE_URL=

OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_AI_API_KEY=

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Never commit `.env`.

Provide:

```text
.env.example
```

instead.

---

# 38. Dependency Boundaries

## Frontend

Frontend may depend on:

```text
API contracts
UI components
frontend state
frontend services
```

Frontend must NOT depend on:

```text
PostgreSQL
LangChain
LangGraph
LLM SDKs
Cloudinary secrets
AI orchestration
```

---

## API Layer

API may depend on:

```text
Application services
Authentication
Validation
```

Controllers must NOT contain:

```text
AI workflows
Complex business logic
Prompt construction
Direct database logic
```

---

## AI Layer

AI may depend on:

```text
LLM providers
Memory services
RAG services
Tool interfaces
```

AI should not directly manage HTTP transport.

---

## Database Layer

Database access must be isolated.

Prefer:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

Do not scatter SQL queries throughout controllers.

---

# 39. Testing Strategy

## Unit Tests

Test independently:

```text
Model routing
Memory extraction
Memory scoring
Context construction
RAG ranking
Tool validation
Prompt construction
```

## Integration Tests

Test:

```text
API → Database
API → LLM Gateway
RAG → pgvector
Memory → Database
Agent → Tool
```

## End-to-End Tests

Test complete workflows:

```text
Tauri
 ↓
API
 ↓
Orchestrator
 ↓
Memory/RAG
 ↓
LLM
 ↓
Response
```

---

# 40. V1 Scope

V1 should include:

```text
Tauri
React
TypeScript
Tailwind CSS

Node.js
Fastify
WebSocket

LangChain
LangGraph

Multiple LLM providers

PostgreSQL
pgvector

Conversation history
Short-term memory
Long-term memory
Episodic memory

RAG

Document ingestion

Cloudinary

Tool system

Streaming
```

---

# 41. V1 Non-Goals

Do NOT introduce these merely for the sake of being "production grade":

```text
Kubernetes
Microservices
Kafka
Service mesh
Multiple database clusters
Dedicated vector database
GPU inference cluster
Distributed agent workers
Complex event-driven architecture
```

These can be introduced when actual requirements justify them.

---

# 42. V2 Evolution

The V1 modular monolith should evolve toward:

```text
                         API Gateway
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       AI Service        Memory Service     Tool Service
            │                 │                 │
            ▼                 ▼                 ▼
       Model Router       Retrieval         Tool Workers
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
               PostgreSQL          Vector Database
                    │
                    ▼
                   Redis
                    │
                    ▼
                  Queue
                    │
                    ▼
             Background Workers
```

Potential V2 components:

```text
Redis
Job queues
Background workers
Dedicated vector database
Object storage
Dedicated AI service
Dedicated memory service
Dedicated RAG service
Horizontal scaling
Observability infrastructure
```

---

# 43. Scaling Principle

The system should scale by separating expensive workloads from request handling.

Bad:

```text
HTTP Request
    ↓
Backend
    ↓
Parse document
    ↓
Generate 500 embeddings
    ↓
Generate summary
    ↓
Return response
```

Better:

```text
HTTP Request
    ↓
Backend
    ↓
Create Job
    ↓
Return
    │
    ▼
Background Worker
    ↓
Parse
    ↓
Chunk
    ↓
Embed
    ↓
Store
```

V1 may initially perform some operations synchronously, but the interfaces must not prevent future background execution.

---

# 44. AI Coding Agent Rules

Any AI coding agent working on GIA MUST follow these rules.

## Rule 1 — Architecture First

Read `ARCHITECTURE.md` before implementing architectural changes.

## Rule 2 — No Provider Lock-In

Never couple application code directly to one LLM provider.

## Rule 3 — Orchestrator Boundary

AI decisions belong inside the AI/orchestration layer.

## Rule 4 — Memory Is Not Chat History

Never automatically convert every conversation message into long-term memory.

## Rule 5 — Memory ≠ RAG

Do not combine the memory and document retrieval systems into one generic system.

## Rule 6 — No Frontend AI Logic

The frontend must not contain model orchestration.

## Rule 7 — No Database Logic in Controllers

Database access belongs behind services/repositories.

## Rule 8 — Secrets Stay Server-Side

Never expose API keys or credentials to the frontend.

## Rule 9 — No Premature Microservices

V1 is a modular monolith.

## Rule 10 — External Services Need Failure Handling

Every external dependency needs timeout/error handling.

## Rule 11 — Reuse Existing Services

Before creating a new service, search the codebase for an existing implementation.

## Rule 12 — Do Not Duplicate Responsibilities

One responsibility should have one authoritative module.

## Rule 13 — Do Not Solve Local Problems With Architectural Changes

A small bug does not justify restructuring the system.

## Rule 14 — Preserve Interfaces

Prefer changing implementations behind stable interfaces.

## Rule 15 — Validate Before Executing Tools

Never execute arbitrary LLM-generated operations without validation and permission checks.

## Rule 16 — Destructive Actions Require Authorization

Deletion, destructive shell commands, and irreversible operations require explicit user approval.

## Rule 17 — Do Not Invent Architecture

If a requested feature conflicts with this document, identify the conflict before implementation.

## Rule 18 — Test Architectural Boundaries

New functionality must have appropriate unit, integration, or end-to-end tests.

---

# 45. Architectural Decision Hierarchy

When making implementation decisions, use this order:

```text
ARCHITECTURE.md
      ↓
Module Responsibility
      ↓
Existing Interfaces
      ↓
Existing Services
      ↓
Implementation
```

The existence of code does not mean that the code is architecturally correct.

If existing code violates this architecture, refactor it when appropriate instead of reproducing the violation.

---

# 46. Example: Memory Request

User:

```text
"What database did I decide to use for GIA?"
```

Execution:

```text
User
 ↓
Intent Analysis
 ↓
Memory Required
 ↓
Memory Retrieval
 ↓
Relevant Memory
 ↓
LLM
 ↓
Response
```

RAG is not required.

---

# 47. Example: RAG Request

User:

```text
"According to my architecture document,
why did we choose PostgreSQL?"
```

Execution:

```text
User
 ↓
Intent Analysis
 ↓
Document Knowledge Required
 ↓
RAG Retrieval
 ↓
Relevant Chunks
 ↓
Context Builder
 ↓
LLM
 ↓
Grounded Response
```

---

# 48. Example: Tool Request

User:

```text
"Search the web for the latest LangGraph release."
```

Execution:

```text
User
 ↓
Intent Analysis
 ↓
External Information Required
 ↓
Tool Selection
 ↓
Web Search Tool
 ↓
Search Result
 ↓
LLM
 ↓
Response
```

The LLM does not directly access the internet.

---

# 49. Example: Complex Agent

User:

```text
"Analyze my project and tell me why
the backend is slow."
```

Execution:

```text
User
 ↓
Intent Analysis
 ↓
Complex Task
 ↓
LangGraph
 ↓
Planning
 ↓
Tool Selection
 ├── File System
 ├── Code Analysis
 └── Database Analysis
 ↓
Tool Results
 ↓
Reasoning Model
 ↓
Validation
 ↓
Response
```

---

# 50. Source of Truth

The repository should contain:

```text
ARCHITECTURE.md

docs/
├── architecture/
├── api/
├── ai/
├── memory/
├── rag/
└── tools/
```

Responsibilities:

```text
ARCHITECTURE.md
→ What the system is.

Implementation
→ How the system currently works.

Tests
→ What behavior must remain correct.

API Documentation
→ How components communicate.
```

---

# 51. Final Architecture

```text
                              GIA
                               │
                               ▼
                       ┌──────────────┐
                       │   Tauri UI   │
                       │ React/TS     │
                       └──────┬───────┘
                              │
                         HTTP/WebSocket
                              │
                              ▼
                       ┌──────────────┐
                       │   Fastify    │
                       │     API      │
                       └──────┬───────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │    AI ORCHESTRATOR     │
                  └───────────┬────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
        Memory              RAG               Tools
            │                 │                 │
            └─────────────────┼─────────────────┘
                              │
                              ▼
                       Model Router
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           OpenAI         Anthropic         Gemini
              │               │               │
              └───────────────┼───────────────┘
                              │
                              ▼
                           Response
                              │
                              ▼
                     ┌─────────────────┐
                     │   PostgreSQL    │
                     │   + pgvector    │
                     └────────┬────────┘
                              │
                              ▼
                         Cloudinary
```

---

# 52. Architectural Summary

GIA is a **modular monolithic AI system** in V1.

The fundamental responsibilities are:

```text
Tauri
→ Desktop application

React
→ User interface

Fastify
→ API and transport

Orchestrator
→ AI coordination

LangGraph
→ Complex agent workflows

LangChain
→ LLM/RAG/tool abstractions

Model Router
→ Model selection

Memory
→ User-specific persistent knowledge

RAG
→ Document/external knowledge grounding

Tools
→ External capabilities

PostgreSQL
→ Persistent application data

pgvector
→ Semantic/vector retrieval

Cloudinary
→ File storage
```

The most important architectural rule is:

```text
                 GIA
                  │
          ┌───────┴───────┐
          │               │
      Intelligence     Capabilities
          │               │
      LLM + Memory     Tools + RAG
          │               │
          └───────┬───────┘
                  │
             Orchestrator
                  │
              Application
```

GIA must remain modular enough that any individual component can be replaced without rewriting the entire system.