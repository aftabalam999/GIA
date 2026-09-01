import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, status
from app.schemas.audio import AudioAnalysisResponseSchema
from app.services.audio_processor import gia_audio_processor
from app.core.exceptions import AudioProcessingException

logger = logging.getLogger("ai_service.routes.audio")
router = APIRouter(prefix="/audio", tags=["Audio Pipeline"])

@router.post("/validate", response_model=AudioAnalysisResponseSchema)
async def validate_audio(file: UploadFile = File(...)):
    """
    Validates uploaded audio payload and computes volume (RMS dB), duration, and silence status.
    Applies canonical GIA specification checks (16kHz Mono, 0.1s - 300s duration).
    """
    if not file:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No audio file provided"
        )

    try:
        raw_bytes = await file.read()
        normalized = gia_audio_processor.decode_and_normalize(
            raw_bytes=raw_bytes,
            filename=file.filename or "audio.wav"
        )

        return AudioAnalysisResponseSchema(
            valid=True,
            sample_rate=normalized.sample_rate,
            channels=normalized.channels,
            duration_seconds=normalized.duration_seconds,
            rms_db=normalized.rms_db,
            is_silent=normalized.is_silent,
            size_bytes=len(normalized.pcm_bytes)
        )
    except AudioProcessingException as ape:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=ape.message
        )
    except Exception as e:
        logger.error(f"Unexpected audio validation failure: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Audio validation failed: {str(e)}"
        )

@router.post("/normalize", response_model=AudioAnalysisResponseSchema)
async def normalize_audio(file: UploadFile = File(...)):
    """
    Decodes input audio container, resamples to 16kHz, converts to Mono,
    and returns normalization metadata.
    """
    return await validate_audio(file)
