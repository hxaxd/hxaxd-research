from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path

from app.platform.db import WorkspaceDatabase
from app.utils.time import utc_now

from .models import (
    IntegrityIssue,
    IntegrityReport,
    ProjectProjection,
    RuntimeCapability,
    WorkspaceCounts,
    WorkspaceProjection,
)

CapabilityProvider = Callable[[], RuntimeCapability]


class WorkspaceProjectionService:
    def __init__(
        self,
        database: WorkspaceDatabase,
        data_dir: Path,
        capability_providers: dict[str, CapabilityProvider] | None = None,
    ) -> None:
        self.database = database
        self.data_dir = data_dir.resolve()
        self.capability_providers = capability_providers or {}

    def get(self) -> WorkspaceProjection:
        with self.database.read() as connection:
            counts = self._counts(connection)
            project_rows = connection.execute(
                """
                SELECT p.id, p.name, p.description, p.updated_at,
                    COUNT(DISTINCT pw.work_id) AS item_count,
                    COUNT(DISTINCT CASE
                        WHEN c.state IN ('staged', 'matched') THEN c.id END
                    ) AS candidate_count
                FROM projects p
                LEFT JOIN project_works pw ON pw.project_id = p.id
                LEFT JOIN candidates c ON c.project_id = p.id
                GROUP BY p.id
                ORDER BY p.updated_at DESC, p.name
                """
            ).fetchall()
            status_rows = connection.execute(
                """
                SELECT project_id, status, COUNT(*) AS count
                FROM project_works GROUP BY project_id, status
                """
            ).fetchall()
        statuses: dict[str, dict[str, int]] = defaultdict(dict)
        for row in status_rows:
            statuses[row["project_id"]][row["status"]] = int(row["count"])
        capabilities = {
            "attachment_upload": RuntimeCapability(
                supported=True,
                ready=True,
                message="可以上传 PDF 与 TeX 源码附件",
            ),
            "durable_jobs": RuntimeCapability(
                supported=True,
                ready=True,
                message="任务状态与事件持久保存",
            ),
        }
        for name, provider in self.capability_providers.items():
            try:
                capabilities[name] = provider()
            except Exception as error:
                capabilities[name] = RuntimeCapability(
                    supported=True,
                    ready=False,
                    message=f"能力检查失败：{error}",
                )
        return WorkspaceProjection(
            generated_at=utc_now(),
            contract_version="4.0",
            schema_version=self.database.schema_version(),
            counts=counts,
            projects=[
                ProjectProjection(**dict(row), status_counts=statuses.get(row["id"], {}))
                for row in project_rows
            ],
            capabilities=capabilities,
        )

    def integrity(self, *, deep: bool = False) -> IntegrityReport:
        issues: list[IntegrityIssue] = []
        verified_files = 0
        with self.database.read() as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            violations = connection.execute("PRAGMA foreign_key_check").fetchall()
            counts = self._counts(connection)
            objects = connection.execute(
                """
                SELECT bo.id, bo.storage_key, bo.state, b.sha256, b.size
                FROM blob_objects bo JOIN blobs b ON b.id = bo.blob_id
                WHERE bo.is_primary = 1
                ORDER BY bo.id
                """
            ).fetchall()
        for row in objects:
            path = self._resolve(row["storage_key"])
            if row["state"] != "available":
                issues.append(
                    IntegrityIssue(
                        kind="blob_state",
                        entity_id=row["id"],
                        message=f"物理对象状态为 {row['state']}",
                    )
                )
                continue
            if path is None or not path.is_file():
                issues.append(
                    IntegrityIssue(
                        kind="missing_file",
                        entity_id=row["id"],
                        message="数据库引用的附件文件不存在",
                    )
                )
                continue
            if path.stat().st_size != row["size"]:
                issues.append(
                    IntegrityIssue(
                        kind="size_mismatch",
                        entity_id=row["id"],
                        message="附件大小与数据库不一致",
                    )
                )
                continue
            if deep and self._sha256(path) != row["sha256"]:
                issues.append(
                    IntegrityIssue(
                        kind="hash_mismatch",
                        entity_id=row["id"],
                        message="附件 SHA-256 与数据库不一致",
                    )
                )
                continue
            verified_files += 1
        for violation in violations:
            issues.append(
                IntegrityIssue(
                    kind="foreign_key",
                    message=f"外键错误：{tuple(violation)}",
                )
            )
        return IntegrityReport(
            checked_at=utc_now(),
            healthy=integrity == "ok" and not violations and not issues,
            deep=deep,
            database_integrity=str(integrity),
            foreign_key_violations=len(violations),
            counts=counts,
            verified_files=verified_files,
            issues=issues,
        )

    @staticmethod
    def _counts(connection) -> WorkspaceCounts:
        expressions = {
            "projects": "SELECT COUNT(*) FROM projects",
            "works": "SELECT COUNT(*) FROM works",
            "items": "SELECT COUNT(*) FROM bibliographic_items",
            "project_works": "SELECT COUNT(*) FROM project_works",
            "candidates": ("SELECT COUNT(*) FROM candidates WHERE state IN ('staged', 'matched')"),
            "attachments": "SELECT COUNT(*) FROM attachments",
            "active_jobs": (
                "SELECT COUNT(*) FROM jobs WHERE status IN "
                "('queued', 'running', 'waiting_approval', 'cancellation_requested')"
            ),
            "pending_approvals": "SELECT COUNT(*) FROM approvals WHERE status = 'pending'",
        }
        values = {
            key: int(connection.execute(statement).fetchone()[0])
            for key, statement in expressions.items()
        }
        return WorkspaceCounts(**values)

    def _resolve(self, storage_key: str) -> Path | None:
        path = (self.data_dir / storage_key).resolve()
        return path if self.data_dir in path.parents else None

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
