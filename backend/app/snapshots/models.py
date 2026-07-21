from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class SnapshotItem(BaseModel):
    filename: str
    size: int
    created_at: datetime
    download_url: str


class SnapshotOverview(BaseModel):
    snapshots: list[SnapshotItem]


class SnapshotRestoreRequest(BaseModel):
    confirmation: str = Field(description="必须与要恢复的快照文件名完全相同")
