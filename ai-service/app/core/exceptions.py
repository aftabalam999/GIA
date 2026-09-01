import logging
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("ai_service.exceptions")

class AIServiceException(Exception):
    """Base exception class for AI Service domain errors."""
    def __init__(self, message: str, status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR):
        self.message = message
        self.status_code = status_code
        super().__init__(message)

class ModelNotReadyException(AIServiceException):
    def __init__(self, message: str = "Model is not initialized or ready"):
        super().__init__(message, status_code=status.HTTP_503_SERVICE_UNAVAILABLE)

class AudioProcessingException(AIServiceException):
    def __init__(self, message: str = "Failed to process audio stream"):
        super().__init__(message, status_code=getattr(status, "HTTP_422_UNPROCESSABLE_ENTITY", 422))

class TranscriptionException(AIServiceException):
    def __init__(self, message: str = "Speech recognition failed"):
        super().__init__(message, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)

class TranscriptionTimeoutException(AIServiceException):
    def __init__(self, message: str = "Speech transcription timed out"):
        super().__init__(message, status_code=status.HTTP_504_GATEWAY_TIMEOUT)

class SynthesisException(AIServiceException):
    def __init__(self, message: str = "Speech synthesis failed"):
        super().__init__(message, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)

class SynthesisTimeoutException(AIServiceException):
    def __init__(self, message: str = "Speech synthesis timed out"):
        super().__init__(message, status_code=status.HTTP_504_GATEWAY_TIMEOUT)


def setup_exception_handlers(app: FastAPI):
    @app.exception_handler(AIServiceException)
    async def ai_service_exception_handler(request: Request, exc: AIServiceException):
        logger.error(f"Domain exception on {request.url.path}: {exc.message}")
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "type": exc.__class__.__name__,
                    "message": exc.message
                }
            }
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        logger.warning(f"Validation error on {request.url.path}: {exc.errors()}")
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": {
                    "type": "ValidationError",
                    "message": "Invalid request payload",
                    "details": exc.errors()
                }
            }
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "type": "HTTPException",
                    "message": exc.detail
                }
            }
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.critical(f"Unhandled exception on {request.url.path}: {str(exc)}", exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "type": "InternalServerError",
                    "message": "An internal server error occurred"
                }
            }
        )
