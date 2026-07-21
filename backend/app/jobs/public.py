from __future__ import annotations

from app.platform.public_projection import sanitize_public_payload, sanitize_public_text

from .models import Job, JobEvent, PublicJob, PublicJobEvent


def project_public_job(job: Job) -> PublicJob:
    return PublicJob(
        id=job.id,
        kind=job.kind,
        subject_type=job.subject_type,
        subject_id=job.subject_id,
        status=job.status,
        priority=job.priority,
        error_code=job.error_code,
        error_message=sanitize_public_text(job.error_message),
        max_attempts=job.max_attempts,
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        cancel_requested_at=job.cancel_requested_at,
    )


def project_public_job_event(event: JobEvent) -> PublicJobEvent:
    return PublicJobEvent(
        id=event.id,
        job_id=event.job_id,
        event_type=event.event_type,
        level=event.level,
        payload=sanitize_public_payload(event.payload),
        created_at=event.created_at,
    )
