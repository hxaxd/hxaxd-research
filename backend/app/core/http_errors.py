from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.library.errors import (
    AttachmentConflictError,
    AttachmentNotFoundError,
    InvalidAttachmentError,
)


def register_error_handlers(app: FastAPI) -> None:
    def payload(code: str, error: Exception) -> dict:
        return {"code": code, "message": str(error), "details": None}

    @app.exception_handler(AttachmentNotFoundError)
    async def not_found(_: Request, error: AttachmentNotFoundError):
        return JSONResponse(status_code=404, content=payload("attachment_not_found", error))

    @app.exception_handler(AttachmentConflictError)
    async def conflict(_: Request, error: AttachmentConflictError):
        return JSONResponse(status_code=409, content=payload("attachment_conflict", error))

    @app.exception_handler(InvalidAttachmentError)
    async def invalid_attachment(_: Request, error: InvalidAttachmentError):
        return JSONResponse(status_code=400, content=payload("invalid_attachment", error))
