import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, status
from app.schemas.vad import VADConfig, VADResult
from app.services.vad_service import gia_vad_service

logger = logging.getLogger("ai_service.routes.vad")
router = APIRouter(prefix="/vad", tags=["Voice Activity Detection"])

@router.get("/config", response_model=VADConfig)
async def get_vad_config():
    """Returns the active VAD configuration parameters."""
    return gia_vad_service.config

@router.post("/config", response_model=VADConfig)
async def update_vad_config(config: VADConfig):
    """Updates VAD parameters dynamically."""
    gia_vad_service.config = config
    return gia_vad_service.config

@router.post("/process", response_model=VADResult)
async def process_vad_chunk(file: UploadFile = File(...)):
    """Processes an incoming audio frame/chunk through the VAD engine."""
    if not file:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No audio frame provided"
        )
    try:
        chunk_bytes = await file.read()
        return gia_vad_service.process_chunk(chunk_bytes)
    except Exception as e:
        logger.error(f"VAD processing error: {e}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"VAD frame processing failed: {str(e)}"
        )
