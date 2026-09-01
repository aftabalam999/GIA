import logging
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from app.schemas.stt import StructuredTranscriptionResult, STTStatusResponse
from app.services.stt_service import gia_stt_service
from app.core.exceptions import (
    ModelNotReadyException,
    AudioProcessingException,
    TranscriptionException,
    TranscriptionTimeoutException
)

logger = logging.getLogger("ai_service.routes.stt")
router = APIRouter(prefix="/stt", tags=["Speech To Text"])

@router.get("/status", response_model=STTStatusResponse)
async def get_stt_status():
    """Returns the STT model lifecycle readiness and device status."""
    return gia_stt_service.get_status()

@router.post("/transcribe", response_model=StructuredTranscriptionResult)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None)
):
    """
    Transcribes uploaded audio into structured text representation.
    Returns text, detected language, confidence score, audio duration, segment timestamps, and processing time.
    """
    if not file:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No audio payload file provided"
        )

    if not gia_stt_service.is_ready():
        status_info = gia_stt_service.get_status()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"STT model is not ready (State: {status_info.state.value}). Error: {status_info.error or 'None'}"
        )

    try:
        audio_bytes = await file.read()
        if not audio_bytes or len(audio_bytes) == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty audio file payload"
            )

        MAX_STT_PAYLOAD_BYTES = 25 * 1024 * 1024  # 25 MB max
        if len(audio_bytes) > MAX_STT_PAYLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Audio payload exceeds maximum size limit of 25 MB"
            )

        return await gia_stt_service.transcribe_structured(
            audio_bytes=audio_bytes,
            filename=file.filename or "audio.wav",
            language=language
        )
    except HTTPException:
        raise
    except ModelNotReadyException as mnre:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=mnre.message
        )
    except AudioProcessingException as ape:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=ape.message
        )
    except TranscriptionTimeoutException as tte:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=tte.message
        )
    except TranscriptionException as te:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=te.message
        )
    except Exception as e:
        logger.error(f"Unexpected error during transcription: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Transcription failed: {str(e)}"
        )
