from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

from .models import JobEvent
from .public import is_public_job_event, project_public_job_event
from .repository import SqliteJobRepository


def format_sse_event(event: JobEvent) -> str:
    payload = project_public_job_event(event).model_dump(mode="json")
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event.id}\nevent: {event.event_type}\ndata: {data}\n\n"


async def stream_job_events(
    repository: SqliteJobRepository,
    job_id: str,
    *,
    after: int = 0,
    poll_interval: float = 0.25,
    heartbeat_seconds: float = 15,
) -> AsyncIterator[str]:
    cursor = after
    last_write = time.monotonic()
    while True:
        events = await asyncio.to_thread(repository.list_events, job_id, after=cursor)
        for event in events:
            cursor = event.id
            if not is_public_job_event(event):
                continue
            last_write = time.monotonic()
            yield format_sse_event(event)
        job = await asyncio.to_thread(repository.get, job_id)
        if job.status.terminal and not events:
            return
        if time.monotonic() - last_write >= heartbeat_seconds:
            last_write = time.monotonic()
            yield ": heartbeat\n\n"
        await asyncio.sleep(poll_interval)
