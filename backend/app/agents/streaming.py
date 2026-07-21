from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

from .models import AgentEvent
from .public import project_public_agent_event
from .repository import SqliteAgentRunRepository


def format_agent_sse_event(event: AgentEvent) -> str:
    data = json.dumps(
        project_public_agent_event(event).model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"id: {event.id}\nevent: {event.event_type}\ndata: {data}\n\n"


async def stream_agent_events(
    repository: SqliteAgentRunRepository,
    run_id: str,
    *,
    after: int = 0,
    poll_interval: float = 0.25,
    heartbeat_seconds: float = 15,
) -> AsyncIterator[str]:
    cursor = after
    last_write = time.monotonic()
    while True:
        events = await asyncio.to_thread(
            repository.list_events,
            run_id,
            after=cursor,
            visibility="public",
        )
        for event in events:
            cursor = event.id
            last_write = time.monotonic()
            yield format_agent_sse_event(event)
        run = await asyncio.to_thread(repository.get, run_id)
        if run.status.terminal and not events:
            return
        if time.monotonic() - last_write >= heartbeat_seconds:
            last_write = time.monotonic()
            yield ": heartbeat\n\n"
        await asyncio.sleep(poll_interval)
