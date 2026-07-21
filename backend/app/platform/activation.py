from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, replace
from enum import StrEnum
from pathlib import Path
from uuid import uuid4

from app.platform.db import DatabaseKind, V3Database, inspect_database

ACTIVATION_JOURNAL_NAME = "workspace-activation.json"

FaultInjector = Callable[[str], None]


class ActivationError(RuntimeError):
    """An activation cannot be completed or safely rolled back."""


class ActivationOperation(StrEnum):
    V2_MIGRATION = "v2_migration"
    SNAPSHOT_RESTORE = "snapshot_restore"


class ActivationPhase(StrEnum):
    PREPARED = "prepared"
    SOURCE_MOVED = "source_moved"
    ACTIVATED = "activated"


@dataclass(frozen=True)
class ActivationMove:
    source: str
    recovery: str


@dataclass(frozen=True)
class ActivationRecord:
    version: int
    operation: str
    phase: str
    scope_root: str
    active: str
    staged: str
    recovery: str
    moves: tuple[ActivationMove, ...] = ()

    @classmethod
    def from_json(cls, payload: str) -> ActivationRecord:
        try:
            raw = json.loads(payload)
            moves = tuple(ActivationMove(**item) for item in raw.get("moves", []))
            return cls(
                version=raw["version"],
                operation=raw["operation"],
                phase=raw["phase"],
                scope_root=raw["scope_root"],
                active=raw["active"],
                staged=raw["staged"],
                recovery=raw["recovery"],
                moves=moves,
            )
        except (AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ActivationError("工作区激活日志损坏，拒绝猜测恢复") from error

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, sort_keys=True, indent=2) + "\n"


class ActivationJournal:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()

    def begin(self, record: ActivationRecord) -> None:
        if self.path.exists():
            raise ActivationError("已有未完成的工作区激活事务")
        self._write(record)

    def load(self) -> ActivationRecord | None:
        if not self.path.exists():
            return None
        if not self.path.is_file():
            raise ActivationError("工作区激活日志不是普通文件")
        try:
            payload = self.path.read_text(encoding="utf-8")
        except OSError as error:
            raise ActivationError("无法读取工作区激活日志") from error
        return ActivationRecord.from_json(payload)

    def set_phase(self, record: ActivationRecord, phase: ActivationPhase) -> ActivationRecord:
        updated = replace(record, phase=phase.value)
        self._write(updated)
        return updated

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
        _sync_directory(self.path.parent)

    def _write(self, record: ActivationRecord) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(record.to_json())
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            _sync_directory(self.path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def default_activation_journal(data_dir: Path) -> Path:
    return data_dir.resolve().parent / ".runtime" / ACTIVATION_JOURNAL_NAME


def activate_v2_database(
    active: Path,
    staged: Path,
    recovery: Path,
    *,
    journal_path: Path,
    fault_injector: FaultInjector | None = None,
) -> None:
    active = active.resolve()
    staged = staged.resolve()
    recovery = recovery.resolve()
    moves = _v2_moves(active, recovery)
    record = ActivationRecord(
        version=1,
        operation=ActivationOperation.V2_MIGRATION.value,
        phase=ActivationPhase.PREPARED.value,
        scope_root=str(active.parent),
        active=str(active),
        staged=str(staged),
        recovery=str(recovery),
        moves=tuple(
            ActivationMove(source=str(source), recovery=str(destination))
            for source, destination in moves
        ),
    )
    _validate_record(record, expected_active=active)
    journal = ActivationJournal(journal_path)
    journal.begin(record)
    try:
        _inject(fault_injector, "v2.after_journal")
        for source, destination in moves:
            if source.exists():
                if destination.exists():
                    raise ActivationError(f"迁移备份目标已经存在: {destination.name}")
                _replace_path(source, destination)
                _inject(fault_injector, f"v2.after_move.{source.name}")
        record = journal.set_phase(record, ActivationPhase.SOURCE_MOVED)
        _inject(fault_injector, "v2.after_source_moved")
        _replace_path(staged, active)
        record = journal.set_phase(record, ActivationPhase.ACTIVATED)
        _inject(fault_injector, "v2.after_activated")
        V3Database(active).verify()
    except Exception:
        try:
            _rollback_v2(record)
        except Exception as rollback_error:
            raise ActivationError(
                "v2 激活失败且自动回滚未完成；已保留激活日志供下次启动恢复"
            ) from rollback_error
        journal.clear()
        raise
    journal.clear()


def activate_snapshot_directory(
    staged: Path,
    active: Path,
    recovery: Path,
    *,
    journal_path: Path,
    fault_injector: FaultInjector | None = None,
) -> None:
    staged = staged.resolve()
    active = active.resolve()
    recovery = recovery.resolve()
    record = ActivationRecord(
        version=1,
        operation=ActivationOperation.SNAPSHOT_RESTORE.value,
        phase=ActivationPhase.PREPARED.value,
        scope_root=str(active.parent),
        active=str(active),
        staged=str(staged),
        recovery=str(recovery),
    )
    _validate_record(record, expected_active=active)
    journal = ActivationJournal(journal_path)
    journal.begin(record)
    try:
        _inject(fault_injector, "snapshot.after_journal")
        if active.exists():
            if any(active.iterdir()):
                _replace_path(active, recovery)
            else:
                active.rmdir()
                _sync_directory(active.parent)
        record = journal.set_phase(record, ActivationPhase.SOURCE_MOVED)
        _inject(fault_injector, "snapshot.after_source_moved")
        _replace_path(staged, active)
        record = journal.set_phase(record, ActivationPhase.ACTIVATED)
        _inject(fault_injector, "snapshot.after_activated")
        V3Database(active / "research.sqlite3").verify()
    except Exception:
        try:
            _rollback_snapshot(record)
        except Exception as rollback_error:
            raise ActivationError(
                "快照激活失败且自动回滚未完成；已保留激活日志供下次启动恢复"
            ) from rollback_error
        journal.clear()
        raise
    journal.clear()


def recover_pending_activation(
    journal_path: Path,
    *,
    data_dir: Path,
    database_path: Path,
) -> str | None:
    journal = ActivationJournal(journal_path)
    record = journal.load()
    if record is None:
        return None
    operation = _operation(record)
    expected_active = (
        database_path.resolve()
        if operation is ActivationOperation.V2_MIGRATION
        else data_dir.resolve()
    )
    _validate_record(record, expected_active=expected_active)
    if operation is ActivationOperation.V2_MIGRATION:
        result = _recover_v2(record, journal)
    else:
        result = _recover_snapshot(record, journal)
    return f"{operation.value}:{result}"


def ensure_no_activation_residue(
    *,
    journal_path: Path,
    data_dir: Path,
    database_path: Path,
) -> None:
    if ActivationJournal(journal_path).load() is not None:
        raise ActivationError("仍有未恢复的工作区激活事务")
    database_state = inspect_database(database_path)
    if database_state.kind not in {DatabaseKind.MISSING, DatabaseKind.EMPTY}:
        return
    data_dir = data_dir.resolve()
    database_path = database_path.resolve()
    residue = [
        *database_path.parent.glob(f".{database_path.name}.v3-migrating-*"),
        *database_path.parent.glob(f"{database_path.name}.v2-*.bak"),
        *data_dir.parent.glob(".snapshot-restore-*"),
        *data_dir.parent.glob(f"{data_dir.name}.before-restore-*"),
    ]
    existing = sorted({path.resolve() for path in residue if path.exists()})
    if existing:
        names = ", ".join(path.name for path in existing[:5])
        raise ActivationError(
            f"活动数据库缺失，但发现无激活日志的迁移或恢复残留（{names}）；拒绝初始化空库"
        )


def _recover_v2(record: ActivationRecord, journal: ActivationJournal) -> str:
    active = Path(record.active)
    staged = Path(record.staged)
    moves = [(Path(move.source), Path(move.recovery)) for move in record.moves]
    if _verified_v3(active) and not staged.exists():
        journal.clear()
        return "committed"
    if _verified_v3(staged):
        active_kind = inspect_database(active).kind
        if active_kind not in {DatabaseKind.LEGACY_V2, DatabaseKind.MISSING}:
            raise ActivationError("v2 激活日志与活动数据库状态冲突")
        _complete_v2_source_moves(moves)
        record = journal.set_phase(record, ActivationPhase.SOURCE_MOVED)
        _replace_path(staged, active)
        journal.set_phase(record, ActivationPhase.ACTIVATED)
        V3Database(active).verify()
        journal.clear()
        return "committed"
    _rollback_v2(record)
    if inspect_database(active).kind is not DatabaseKind.LEGACY_V2:
        raise ActivationError("无法从 v2 备份恢复活动数据库")
    staged.unlink(missing_ok=True)
    journal.clear()
    return "rolled_back"


def _recover_snapshot(record: ActivationRecord, journal: ActivationJournal) -> str:
    active = Path(record.active)
    staged = Path(record.staged)
    recovery = Path(record.recovery)
    stage_valid = _verified_v3(staged / "research.sqlite3")
    active_valid = _verified_v3(active / "research.sqlite3")
    if not staged.exists() and active_valid:
        journal.clear()
        return "committed"
    if stage_valid:
        if active.exists() and recovery.exists():
            raise ActivationError("快照激活残留同时包含活动目录和恢复目录，拒绝猜测覆盖")
        if active.exists():
            if any(active.iterdir()):
                _replace_path(active, recovery)
            else:
                active.rmdir()
                _sync_directory(active.parent)
        record = journal.set_phase(record, ActivationPhase.SOURCE_MOVED)
        _replace_path(staged, active)
        journal.set_phase(record, ActivationPhase.ACTIVATED)
        V3Database(active / "research.sqlite3").verify()
        journal.clear()
        return "committed"
    if active_valid and not recovery.exists():
        journal.clear()
        return "rolled_back"
    if not active.exists() and _verified_v3(recovery / "research.sqlite3"):
        _replace_path(recovery, active)
        journal.clear()
        return "rolled_back"
    raise ActivationError("快照激活残留无法验证；拒绝初始化或覆盖工作区")


def _rollback_v2(record: ActivationRecord) -> None:
    active = Path(record.active)
    staged = Path(record.staged)
    moves = [(Path(move.source), Path(move.recovery)) for move in record.moves]
    if inspect_database(active).kind is DatabaseKind.V3 and not staged.exists():
        _replace_path(active, staged)
    for source, recovery in reversed(moves):
        if source.exists() and recovery.exists():
            raise ActivationError(f"v2 回滚路径冲突: {source.name}")
        if recovery.exists():
            _replace_path(recovery, source)
    if inspect_database(active).kind is not DatabaseKind.LEGACY_V2:
        raise ActivationError("v2 活动数据库没有恢复到可验证状态")
    staged.unlink(missing_ok=True)
    _sync_directory(staged.parent)


def _rollback_snapshot(record: ActivationRecord) -> None:
    active = Path(record.active)
    staged = Path(record.staged)
    recovery = Path(record.recovery)
    if active.exists() and recovery.exists() and not staged.exists():
        staged.parent.mkdir(parents=True, exist_ok=True)
        _replace_path(active, staged)
    if recovery.exists():
        if active.exists():
            raise ActivationError("快照回滚时活动目录与恢复目录同时存在")
        _replace_path(recovery, active)


def _complete_v2_source_moves(moves: Iterable[tuple[Path, Path]]) -> None:
    for index, (source, recovery) in enumerate(moves):
        if source.exists() and recovery.exists():
            raise ActivationError(f"v2 激活路径冲突: {source.name}")
        if source.exists():
            _replace_path(source, recovery)
        elif index == 0 and not recovery.exists():
            raise ActivationError("v2 活动数据库及其备份同时缺失")


def _validate_record(record: ActivationRecord, *, expected_active: Path) -> None:
    if record.version != 1:
        raise ActivationError("工作区激活日志版本不受支持")
    operation = _operation(record)
    try:
        ActivationPhase(record.phase)
    except ValueError as error:
        raise ActivationError("工作区激活日志阶段无效") from error
    root = _absolute_path(record.scope_root, "scope_root")
    active = _absolute_path(record.active, "active")
    staged = _absolute_path(record.staged, "staged")
    recovery = _absolute_path(record.recovery, "recovery")
    if root != expected_active.resolve().parent or active != expected_active.resolve():
        raise ActivationError("工作区激活日志不属于当前工作区")
    if active.parent != root or recovery.parent != root:
        raise ActivationError("工作区激活日志包含越界路径")
    if len({active, staged, recovery}) != 3:
        raise ActivationError("工作区激活日志路径发生重叠")
    if operation is ActivationOperation.V2_MIGRATION:
        expected_moves = _v2_moves(active, recovery)
        actual_moves = [
            (
                _absolute_path(move.source, "move.source"),
                _absolute_path(move.recovery, "move.recovery"),
            )
            for move in record.moves
        ]
        if staged.parent != root or not staged.name.startswith(f".{active.name}.v3-migrating-"):
            raise ActivationError("v2 激活日志的影子数据库路径无效")
        if not recovery.name.startswith(f"{active.name}.v2-") or not recovery.name.endswith(".bak"):
            raise ActivationError("v2 激活日志的备份路径无效")
        if actual_moves != expected_moves:
            raise ActivationError("v2 激活日志的文件移动集合无效")
    else:
        if record.moves:
            raise ActivationError("快照激活日志包含非预期文件移动")
        if not staged.is_relative_to(root) or staged.name != "data":
            raise ActivationError("快照激活日志的暂存目录路径无效")
        if not staged.parent.name.startswith(".snapshot-restore-"):
            raise ActivationError("快照激活日志的暂存目录名称无效")
        if not recovery.name.startswith(f"{active.name}.before-restore-"):
            raise ActivationError("快照激活日志的恢复目录路径无效")


def _operation(record: ActivationRecord) -> ActivationOperation:
    try:
        return ActivationOperation(record.operation)
    except ValueError as error:
        raise ActivationError("工作区激活日志操作类型无效") from error


def _absolute_path(value: str, field: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ActivationError(f"工作区激活日志字段 {field} 不是绝对路径")
    return path.resolve()


def _v2_moves(active: Path, recovery: Path) -> list[tuple[Path, Path]]:
    return [
        (active, recovery),
        (
            active.with_name(f"{active.name}-wal"),
            recovery.with_name(f"{recovery.name}-wal"),
        ),
        (
            active.with_name(f"{active.name}-shm"),
            recovery.with_name(f"{recovery.name}-shm"),
        ),
    ]


def _verified_v3(path: Path) -> bool:
    if inspect_database(path).kind is not DatabaseKind.V3:
        return False
    try:
        V3Database(path).verify()
    except (OSError, RuntimeError, sqlite3.DatabaseError):
        return False
    return True


def _replace_path(source: Path, destination: Path) -> None:
    os.replace(source, destination)
    _sync_directory(source.parent)
    if destination.parent != source.parent:
        _sync_directory(destination.parent)


def _sync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _inject(fault_injector: FaultInjector | None, point: str) -> None:
    if fault_injector is not None:
        fault_injector(point)
