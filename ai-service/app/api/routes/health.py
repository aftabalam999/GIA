from datetime import datetime, timezone
from fastapi import APIRouter
from app.core.config import settings
from app.schemas.health import HealthResponse, ServiceInfoResponse
from app.models.lifecycle import model_lifecycle

router = APIRouter(tags=["System / Health"])

@router.get("/health", response_model=HealthResponse)
@router.get("/api/v1/health", response_model=HealthResponse)
async def get_health():
    is_ready = model_lifecycle.is_overall_ready()
    return HealthResponse(
        status="healthy",
        ready=is_ready,
        version=settings.VERSION,
        service_name=settings.APP_NAME,
        timestamp=datetime.now(timezone.utc).isoformat(),
        subsystems=model_lifecycle.get_subsystem_statuses()
    )

@router.get("/v1/health/readiness", response_model=HealthResponse)
@router.get("/api/v1/health/readiness", response_model=HealthResponse)
async def get_readiness():
    is_ready = model_lifecycle.is_overall_ready()
    subsystems = model_lifecycle.get_subsystem_statuses()
    
    if not is_ready:
        from fastapi import Response, status
        return Response(
            content=HealthResponse(
                status="healthy",
                ready=False,
                version=settings.VERSION,
                service_name=settings.APP_NAME,
                timestamp=datetime.now(timezone.utc).isoformat(),
                subsystems=subsystems
            ).model_dump_json(),
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            media_type="application/json"
        )

    return HealthResponse(
        status="healthy",
        ready=True,
        version=settings.VERSION,
        service_name=settings.APP_NAME,
        timestamp=datetime.now(timezone.utc).isoformat(),
        subsystems=subsystems
    )

@router.get("/info", response_model=ServiceInfoResponse)
@router.get("/api/v1/info", response_model=ServiceInfoResponse)
async def get_info():
    return ServiceInfoResponse(
        name=settings.APP_NAME,
        version=settings.VERSION,
        description="Dedicated ML and Voice Service for GIA AI Assistant",
        environment=settings.ENVIRONMENT
    )
