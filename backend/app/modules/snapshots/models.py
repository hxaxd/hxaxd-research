from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class SnapshotOperationKind(StrEnum):
    BACKUP = "backup"
    RESTORE = "restore"


class SnapshotOperationStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class SnapshotOperation(BaseModel):
    id: str
    kind: SnapshotOperationKind
    status: SnapshotOperationStatus
    message: str
    filename: str | None
    error: str | None
    started_at: datetime
    finished_at: datetime | None


class SnapshotItem(BaseModel):
    filename: str
    size: int
    created_at: datetime
    download_url: str


class SnapshotOverview(BaseModel):
    snapshots: list[SnapshotItem]
    operation: SnapshotOperation | None


class SnapshotRestoreRequest(BaseModel):
    confirmation: str = Field(description="必须与要恢复的快照文件名完全相同")
