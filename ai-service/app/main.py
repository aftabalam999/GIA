from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.logging import setup_logging, get_logger
from app.core.exceptions import setup_exception_handlers
from app.api.router import api_router
from app.models.lifecycle import model_lifecycle

setup_logging()
logger = get_logger("ai_service.main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting {settings.APP_NAME} v{settings.VERSION} [{settings.ENVIRONMENT}]...")
    await model_lifecycle.startup()
    yield
    logger.info(f"Shutting down {settings.APP_NAME}...")
    await model_lifecycle.shutdown()

app = FastAPI(
    title=settings.APP_NAME,
    description="Dedicated AI/ML and Voice Service hosting STT, TTS, VAD, and Audio Processing abstractions.",
    version=settings.VERSION,
    lifespan=lifespan
)

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Exception handlers & routes
setup_exception_handlers(app)
app.include_router(api_router)

@app.get("/")
async def root():
    return {
        "service": settings.APP_NAME,
        "version": settings.VERSION,
        "status": "running"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
