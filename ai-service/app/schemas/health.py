from pydantic import BaseModel, Field
from typing import Dict

class HealthResponse(BaseModel):
    status: str = Field("healthy", description="Overall service status (UP/healthy)")
    ready: bool = Field(True, description="Overall subsystem model readiness for inference")
    version: str = Field(..., description="Service version string")
    service_name: str = Field(..., description="Name of the service")
    timestamp: str = Field(..., description="ISO 8601 UTC timestamp")
    subsystems: Dict[str, bool] = Field(default_factory=dict, description="Status of registered model subsystems")

class ServiceInfoResponse(BaseModel):
    name: str
    version: str
    description: str
    environment: str
