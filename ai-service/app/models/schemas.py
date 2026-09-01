from pydantic import BaseModel, Field

class HealthStatus(BaseModel):
    status: str = "healthy"
    timestamp: str
