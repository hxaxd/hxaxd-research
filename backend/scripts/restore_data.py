from __future__ import annotations

import argparse
from pathlib import Path

from app.core.config import Settings
from app.core.database import SCHEMA_PATH
from app.utils.snapshots.errors import SnapshotError
from app.utils.snapshots.restore import SnapshotRestorer


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="用精确版本快照重建研究应用数据")
    parser.add_argument("snapshot", type=Path, help="要重建的 .researchpack 文件")
    parser.add_argument("--data-dir", type=Path, help="覆盖默认数据目录，仅用于运维")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="替换非空数据目录，并把原目录保留为 before-restore 恢复副本",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    settings = Settings.from_environment()
    data_dir = (arguments.data_dir or settings.data_dir).resolve()
    try:
        result = SnapshotRestorer(SCHEMA_PATH).restore(
            arguments.snapshot,
            data_dir,
            replace=arguments.replace,
        )
    except SnapshotError as error:
        print(f"重建失败: {error}")
        return 1
    print(f"重建完成: {result.data_dir} ({result.file_count} 个数据文件)")
    if result.recovery_dir is not None:
        print(f"原数据保留在: {result.recovery_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
