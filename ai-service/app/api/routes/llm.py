import logging
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.responses import StreamingResponse

from app.schemas.llm import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    GenerateRequest,
    GenerateResponse,
    LLMHealthResponse,
    LLMInfoResponse,
)
from app.services.llm_service import gia_llm_service

logger = logging.getLogger("ai_service.api.routes.llm")

router = APIRouter(tags=["Local Qwen LLM"])

@router.get("/health", response_model=LLMHealthResponse)
async def get_llm_health():
    """
    GET /api/llm/health
    Returns health, initialization state, memory usage, and device status of local Qwen 3.5 4B.
    """
    return gia_llm_service.get_status()

@router.get("/info", response_model=LLMInfoResponse)
async def get_llm_info():
    """
    GET /api/llm/info
    Returns architectural specifications, vocabulary size, and runtime parameters.
    """
    return gia_llm_service.get_info()

@router.post("/chat", response_model=ChatCompletionResponse)
async def chat_completion(request: ChatCompletionRequest):
    """
    POST /api/llm/chat
    Synchronous / non-streaming conversation completion.
    Supports system instructions, conversation history, JSON output, and native XML tool calling.
    """
    if not request.messages:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Messages list must contain at least one message."
        )

    try:
        response = await gia_llm_service.chat(request)
        return response
    except FileNotFoundError as fnf:
        logger.error(f"Local Qwen model files missing: {fnf}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Local model weights not found on disk: {str(fnf)}"
        )
    except Exception as e:
        logger.exception(f"Error during LLM chat completion: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM inference execution error: {str(e)}"
        )

@router.post("/chat/stream")
async def chat_completion_stream(request: ChatCompletionRequest):
    """
    POST /api/llm/chat/stream
    Asynchronous Server-Sent Events (SSE) streaming token generator.
    Streams incremental delta tokens in standard OpenAI-compatible chunks.
    """
    if not request.messages:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Messages list must contain at least one message."
        )

    try:
        generator = gia_llm_service.stream_chat(request)
        return StreamingResponse(
            generator,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )
    except FileNotFoundError as fnf:
        logger.error(f"Local Qwen model files missing: {fnf}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Local model weights not found on disk: {str(fnf)}"
        )
    except Exception as e:
        logger.exception(f"Error during LLM streaming: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM streaming error: {str(e)}"
        )

@router.post("/generate", response_model=GenerateResponse)
async def generate_text(request: GenerateRequest):
    """
    POST /api/llm/generate
    Direct raw text prompt completion.
    """
    if not request.prompt or not request.prompt.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Prompt text must not be empty."
        )

    try:
        response = await gia_llm_service.generate(request)
        return response
    except FileNotFoundError as fnf:
        logger.error(f"Local Qwen model files missing: {fnf}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Local model weights not found on disk: {str(fnf)}"
        )
    except Exception as e:
        logger.exception(f"Error during LLM generate: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM generation error: {str(e)}"
        )

