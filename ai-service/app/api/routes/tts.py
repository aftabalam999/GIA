import logging
from typing import Optional
from fastapi import APIRouter, Response, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from app.services.tts_service import gia_tts_service
from app.schemas.tts import TTSSynthesizeRequest, TTSStatusResponse
from app.core.exceptions import (
    AIServiceException,
    ModelNotReadyException,
    SynthesisTimeoutException,
    SynthesisException,
)

logger = logging.getLogger("ai_service.routes.tts")
router = APIRouter(prefix="/tts", tags=["Text To Speech"])

@router.post("/synthesize")
async def synthesize_speech(
    req: TTSSynthesizeRequest,
    stream: bool = Query(False, description="Set to true for chunked audio stream")
):
    """
    Synthesizes input text into a WAV audio stream suitable for desktop playback.
    """
    if not gia_tts_service.is_ready():
        raise ModelNotReadyException("TTS engine is not initialized or ready")

    if stream:
        return StreamingResponse(
            gia_tts_service.synthesize_stream(
                text=req.text,
                voice=req.voice,
                language=req.language
            ),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=synthesized_stream.wav",
                "X-Audio-Sample-Rate": str(gia_tts_service.sample_rate)
            }
        )

    try:
        audio_bytes = await gia_tts_service.synthesize(
            text=req.text,
            voice=req.voice,
            language=req.language
        )
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=synthesized.wav",
                "Content-Length": str(len(audio_bytes)),
                "X-Audio-Sample-Rate": str(gia_tts_service.sample_rate)
            }
        )
    except AIServiceException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error during TTS synthesis: {e}", exc_info=True)
        raise SynthesisException(f"TTS synthesis failed: {str(e)}")

@router.get("/status", response_model=TTSStatusResponse)
async def get_tts_status():
    """
    Returns TTS model readiness, configuration, device, and status details.
    """
    return gia_tts_service.get_status()
