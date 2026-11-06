from fastapi import APIRouter, Depends
from app.api.routes import health, audio, vad, stt, tts, embeddings, reranker, llm
from app.core.auth import verify_internal_api_key

api_router = APIRouter()

# Unauthenticated public health & info checks
api_router.include_router(health.router)

# Local Qwen LLM Endpoints (/api/llm and /llm)
api_router.include_router(llm.router, prefix="/api/llm")
api_router.include_router(llm.router, prefix="/llm")

# Protected internal AI service endpoints requiring X-Internal-API-Key header
protected_dependencies = [Depends(verify_internal_api_key)]

api_router.include_router(audio.router, prefix="/api/v1", dependencies=protected_dependencies)
api_router.include_router(vad.router, prefix="/api/v1", dependencies=protected_dependencies)
api_router.include_router(stt.router, prefix="/api/v1", dependencies=protected_dependencies)
api_router.include_router(stt.router, prefix="/v1", dependencies=protected_dependencies)
api_router.include_router(tts.router, prefix="/api/v1", dependencies=protected_dependencies)
api_router.include_router(tts.router, prefix="/v1", dependencies=protected_dependencies)
api_router.include_router(embeddings.router, prefix="/api", dependencies=protected_dependencies)
api_router.include_router(embeddings.router, dependencies=protected_dependencies)
api_router.include_router(reranker.router, prefix="/api", dependencies=protected_dependencies)
api_router.include_router(reranker.router, dependencies=protected_dependencies)
