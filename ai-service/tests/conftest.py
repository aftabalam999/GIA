import pytest
from fastapi.testclient import TestClient as OriginalTestClient
from app.main import app
from app.core.config import settings

class AuthenticatedTestClient(OriginalTestClient):
    def __init__(self, app, **kwargs):
        headers = kwargs.pop("headers", None) or {}
        if "x-internal-api-key" not in headers:
            headers["x-internal-api-key"] = settings.INTERNAL_API_KEY
        super().__init__(app, headers=headers, **kwargs)

@pytest.fixture
def client():
    with AuthenticatedTestClient(app) as test_client:
        yield test_client
