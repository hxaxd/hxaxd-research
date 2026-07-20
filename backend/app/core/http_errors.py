from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .errors import (
    InvalidArtifactError,
    InvalidSnapshotError,
    ResourceConflictError,
    ResourceNotFoundError,
    TranslationExecutionError,
)


def register_error_handlers(app: FastAPI) -> None:
    def payload(code: str, error: Exception) -> dict:
        return {"code": code, "message": str(error), "details": None}

    @app.exception_handler(ResourceNotFoundError)
    async def not_found(_: Request, error: ResourceNotFoundError):
        return JSONResponse(status_code=404, content=payload("resource_not_found", error))

    @app.exception_handler(ResourceConflictError)
    async def conflict(_: Request, error: ResourceConflictError):
        return JSONResponse(status_code=409, content=payload("resource_conflict", error))

    @app.exception_handler(InvalidArtifactError)
    async def invalid_artifact(_: Request, error: InvalidArtifactError):
        return JSONResponse(status_code=400, content=payload("invalid_resource", error))

    @app.exception_handler(InvalidSnapshotError)
    async def invalid_snapshot(_: Request, error: InvalidSnapshotError):
        return JSONResponse(status_code=400, content=payload("invalid_snapshot", error))

    @app.exception_handler(TranslationExecutionError)
    async def translation_failure(_: Request, error: TranslationExecutionError):
        return JSONResponse(status_code=500, content=payload("job_execution_failed", error))
