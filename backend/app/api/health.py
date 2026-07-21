from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response, status

router = APIRouter(tags=["health"])


@router.get("/health")
def health(request: Request, response: Response) -> dict[str, Any]:
    worker = request.app.state.context.job_worker
    worker_alive = worker.is_alive
    last_error = worker.last_error
    ready = worker_alive and last_error is None
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "status": "ok" if ready else "degraded",
        "durable_jobs": {
            "ready": ready,
            "worker_alive": worker_alive,
            "error_code": "job_worker_error" if last_error is not None else None,
        },
    }
