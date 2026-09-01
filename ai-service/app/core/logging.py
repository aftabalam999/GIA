import logging
import sys
from app.core.config import settings

def setup_logging():
    log_level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)
    
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers = [handler]

    # Silence overly verbose third-party loggers
    for logger_name in ["uvicorn", "uvicorn.access", "asyncio"]:
        logging.getLogger(logger_name).setLevel(log_level)

def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
