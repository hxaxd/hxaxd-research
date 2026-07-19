from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import Job, TranslationRequest
from .service import TranslationService

router = APIRouter(tags=["translations"])


def get_service(request: Request) -> TranslationService:
    return get_app_context(request).translations


@router.post("/papers/{paper_id}/translate", response_model=Job, status_code=202)
def translate_paper(
    paper_id: str,
    payload: TranslationRequest,
    service: Annotated[TranslationService, Depends(get_service)],
) -> Job:
    return service.translate(paper_id, payload)


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(
    job_id: str,
    service: Annotated[TranslationService, Depends(get_service)],
) -> Job:
    return service.get_job(job_id)
