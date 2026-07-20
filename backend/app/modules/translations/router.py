from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import Job, JobRequest, TranslationRequest
from .service import JobService

router = APIRouter(tags=["jobs"])


def get_service(request: Request) -> JobService:
    return get_app_context(request).jobs


@router.post("/jobs", response_model=Job, status_code=202)
def create_job(payload: JobRequest, service: Annotated[JobService, Depends(get_service)]) -> Job:
    return service.create(payload)


@router.post("/papers/{paper_id}/translate", response_model=Job, status_code=202)
def translate_paper(
    paper_id: str,
    payload: TranslationRequest,
    service: Annotated[JobService, Depends(get_service)],
) -> Job:
    return service.translate_legacy(paper_id, payload)


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str, service: Annotated[JobService, Depends(get_service)]) -> Job:
    return service.get_job(job_id)
