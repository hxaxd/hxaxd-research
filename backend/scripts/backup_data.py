from __future__ import annotations

import argparse
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import BACKEND_ROOT, Settings
from app.core.database import SCHEMA_PATH
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.errors import SnapshotError


def parse_arguments() -> argparse.Namespace:
    timestamp = datetime.now(UTC).strftime("%Y-%m-%d_%H%M%SZ")
    parser = argparse.ArgumentParser(description="打包当前版本的全部研究应用数据")
    parser.add_argument(
        "--output",
        type=Path,
        default=BACKEND_ROOT / "snapshots" / f"research-{timestamp}.researchpack",
        help="输出的 .researchpack 文件",
    )
    parser.add_argument("--data-dir", type=Path, help="覆盖默认数据目录，仅用于运维")
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    settings = Settings.from_environment()
    data_dir = (arguments.data_dir or settings.data_dir).resolve()
    writer = SnapshotWriter(data_dir, data_dir / "research.sqlite3", SCHEMA_PATH)
    try:
        result = writer.write(arguments.output)
    except SnapshotError as error:
        print(f"备份失败: {error}")
        return 1
    print(f"备份完成: {result.archive_path} ({result.file_count} 个数据文件)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
