# GIA AI Service — Python FastAPI ML & Voice Subsystem

Dedicated Python AI/ML micro-service hosting model lifecycle management, STT (Speech-to-Text), TTS (Text-to-Speech), VAD (Voice Activity Detection), and Audio Processing abstractions for GIA.

---

## 1. Directory Structure

```text
ai-service/
├── app/
│   ├── main.py               # FastAPI application entrypoint & lifespan management
│   ├── api/                  # API routers and endpoints
│   │   ├── router.py         # Main aggregator router
│   │   └── routes/           # Endpoint handlers (/health, /info)
│   ├── core/                 # Core configuration, logging, and custom exception handlers
│   │   ├── config.py         # Environment configuration (Pydantic Settings)
│   │   ├── logging.py        # Structured logging setup
│   │   └── exceptions.py     # Custom domain exceptions and global error handlers
│   ├── models/               # Subsystem lifecycle management
│   │   └── lifecycle.py      # Model lifecycle manager (register, startup, shutdown, readiness)
│   ├── schemas/              # Request/Response Pydantic schemas
│   │   ├── health.py         # Health and Service Info schemas
│   │   └── audio.py          # Audio STT/TTS metadata schemas
│   ├── services/             # Abstract Base Interfaces (Subsystem Abstractions)
│   │   ├── base_stt.py       # SpeechToTextService (ABC)
│   │   ├── base_tts.py       # TextToSpeechService (ABC)
│   │   ├── base_audio.py     # AudioProcessor (ABC)
│   │   └── base_vad.py       # VoiceActivityDetector (ABC)
│   └── utils/                # Utility helpers
├── tests/                    # Pytest test suite
│   ├── conftest.py           # TestClient fixture
│   ├── test_health.py        # API health check tests
│   └── test_service_interfaces.py # Subsystem interface & lifecycle manager tests
├── requirements.txt          # Python package requirements
└── README.md                 # Service documentation
```

---

## 2. Environment Configuration

The service loads configuration from environment variables or `.env` in `ai-service/`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `127.0.0.1` | Network interface host to bind FastAPI |
| `PORT` | `8001` | Service port |
| `LOG_LEVEL` | `INFO` | Logging level (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |
| `ENVIRONMENT` | `development` | Deployment environment |

---

## 3. Running the Service Independently

The Python AI service runs standalone without requiring Node.js:

```bash
# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run FastAPI server
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

The service interactive OpenAPI documentation will be accessible at `http://127.0.0.1:8001/docs`.

---

## 4. Running Pytest Suite

```bash
PYTHONPATH=. pytest tests
```
