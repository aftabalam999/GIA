# GIA — API Documentation & Developer Testing Guide

This documentation guides developers on how to test, inspect, and consume GIA backend services.

The complete Swagger API specification is defined in [openapi.yaml](file:///home/jasin/Desktop/GIA-AI/openapi.yaml).

---

## 1. Running the Local API Server

Start the PostgreSQL database and Redis services container:
```bash
npm run db:up
```

Run the Fastify development API server:
```bash
npm run backend:dev
```
The server will bind to `http://localhost:5000` with CORS headers enabled.

---

## 2. Authentication Protocol

GIA supports a dual-authentication mechanism:

1. **Stateful HttpOnly Cookie (Primary Web Client)**
   - When a user calls `/auth/signup` or `/auth/login`, the server issues a cookie: `session_id=<opaque_id>`.
   - The cookie is marked `HttpOnly` and `SameSite=Lax`.
   - The browser automatically transmits this cookie on all subsequent REST API calls and WebSocket upgrades.
2. **Bearer Token Fallback (API Clients & Testing)**
   - When a user logs in, the JSON response body also contains `token: "<opaque_id>"`.
   - Command-line scripts, automated integrations, and tests can pass this session ID in the HTTP headers:
     `Authorization: Bearer <session_id>`

---

## 3. Quick Testing with Curl

### A. Signup and Get Session
```bash
curl -i -X POST http://localhost:5000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"developer@gia.ai", "password":"secure_password_123", "name":"Developer Name"}'
```
This returns the session cookie in the `Set-Cookie` header and a matching opaque `token` string in the JSON payload.

### B. Access Profile using Bearer Token
```bash
curl -i -X GET http://localhost:5000/api/v1/auth/me \
  -H "Authorization: Bearer <SESSION_ID>"
```

### C. Perform Deep Dependency Health Audit
```bash
curl -i -X GET http://localhost:5000/api/v1/health/dependencies
```

---

## 4. Loading the Swagger File into Testing Interfaces

You can interactively test all endpoints using standard OpenAPI visualizers:

### **Swagger Editor (Web)**
1. Open the [Swagger Editor](https://editor.swagger.io/).
2. Click **File -> Import file** and select [openapi.yaml](file:///home/jasin/Desktop/GIA-AI/openapi.yaml).
3. The editor renders an interactive right-hand panel. Click **Authorize** and input a valid Bearer token or select Cookie auth.

### **Postman**
1. Open Postman.
2. Click **Import** and upload [openapi.yaml](file:///home/jasin/Desktop/GIA-AI/openapi.yaml).
3. Postman automatically builds a collection complete with folders, request payload templates, and variables.

### **Scalar API Reference**
GIA is compatible with Scalar and standard OpenAPI viewers.

---

## 5. Key Endpoint Categories

| Path | Method | Description |
| :--- | :--- | :--- |
| `/auth/login` | `POST` | Authenticate credentials and establish a Redis session. |
| `/auth/logout` | `POST` | Revoke the active session ID from Redis and clear browser cookies. |
| `/health/ready` | `GET` | Readiness check. Returns `200` if DB/Redis are connected; `503` if down. |
| `/health/dependencies` | `GET` | Detailed check auditing database, Redis, LLM, and Embedding endpoints. |
| `/conversations` | `POST` | Create a new discussion thread. |
| `/conversations/{id}/messages/rag` | `POST` | Query LLM augmented with semantic user memories and document embeddings. |
| `/conversations/{id}/messages/agent` | `POST` | Submit queries executing the FSM Orchestrator (Planning -> Execute -> Respond). |
| `/memories/search` | `GET` | Semantic search memories using pgvector cosine similarity index. |
| `/documents` | `POST` | Index documents into paragraph vector chunks. |
| `/tools/execute` | `POST` | Directly run authorized read-only tools. |

---

## 6. Real-time Streaming (WebSockets)

GIA supports streaming completions via WebSockets:

- **WS Endpoint**: `ws://localhost:5000/api/v1/chat/stream`
- **Handshake auth**: Automatically transmits browser cookies or reads `?token=<session_id>` query parameters.
- **Client payload**:
  ```json
  {
    "conversation_id": "c3a092d6-47b2-4d43-aa9d-29bcbb3f374c",
    "content": "Tell me a joke."
  }
  ```
- **Stream events**:
  - `type: "chunk"`: real-time character string.
  - `type: "done"`: completes generation and returns complete message record.
  - `type: "error"`: reports errors.
