from __future__ import annotations

import sqlite3
from pathlib import Path

from .errors import SnapshotError


def validate_database(database_path: Path) -> None:
    try:
        connection = sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    except sqlite3.DatabaseError as error:
        raise SnapshotError("快照数据库无法读取") from error
    finally:
        if "connection" in locals():
            connection.close()
    if integrity is None or integrity[0] != "ok":
        raise SnapshotError("快照数据库完整性检查失败")
    if foreign_key_violations:
        raise SnapshotError("快照数据库包含外键错误")
