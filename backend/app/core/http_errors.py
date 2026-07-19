from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .errors import (
    InvalidArtifactError,
    ResourceConflictError,
    ResourceNotFoundError,
    TranslationExecutionError,
)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ResourceNotFoundError)
    async def not_found(_: Request, error: ResourceNotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(error)})

    @app.exception_handler(ResourceConflictError)
    async def conflict(_: Request, error: ResourceConflictError):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(InvalidArtifactError)
    async def invalid_artifact(_: Request, error: InvalidArtifactError):
        return JSONResponse(status_code=400, content={"detail": str(error)})

    @app.exception_handler(TranslationExecutionError)
    async def translation_failure(_: Request, error: TranslationExecutionError):
        return JSONResponse(status_code=500, content={"detail": str(error)})
