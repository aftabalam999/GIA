import logging
from typing import Optional
from fastapi import APIRouter, Response, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from app.services.kokoro_tts import gia_kokoro_service
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
    Supports English ('af_heart') and Hindi ('hf_alpha') with automatic language detection.
    """
    if not gia_kokoro_service.is_ready():
        raise ModelNotReadyException("Kokoro TTS engine is not initialized or ready")

    if stream:
        return StreamingResponse(
            gia_kokoro_service.synthesize_stream(
                text=req.text,
                voice=req.voice,
                speed=req.speed,
                language=req.language
            ),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=synthesized_stream.wav",
                "X-Audio-Sample-Rate": str(gia_kokoro_service.sample_rate)
            }
        )

    try:
        audio_bytes, meta = await gia_kokoro_service.synthesize_with_metadata(
            text=req.text,
            voice=req.voice,
            speed=req.speed,
            language=req.language
        )
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=synthesized.wav",
                "Content-Length": str(len(audio_bytes)),
                "X-Audio-Sample-Rate": str(meta.sample_rate),
                "X-TTS-Language": meta.language,
                "X-TTS-Voice": meta.voice,
                "X-TTS-Speed": str(meta.speed),
                "X-TTS-Duration": str(meta.duration_seconds),
                "X-TTS-Device": meta.device,
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
    return gia_kokoro_service.get_status()
