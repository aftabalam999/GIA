import logging
from fastapi import Header, HTTPException, status
from app.core.config import settings

logger = logging.getLogger("ai_service.core.auth")

async def verify_internal_api_key(
    x_internal_api_key: str = Header(None, alias="x-internal-api-key")
):
    """
    Verifies that incoming requests from Fastify carry a valid internal API key.
    Prevents the Python AI service from operating as an unrestricted public endpoint.
    """
    # In testing environment or when key is set, enforce strict validation
    expected_key = settings.INTERNAL_API_KEY
    if not expected_key:
        return

    if not x_internal_api_key or x_internal_api_key != expected_key:
        logger.warning("Rejected unauthorized call to Python AI service: Invalid or missing X-Internal-API-Key header")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized access: Invalid internal service authentication key"
        )
