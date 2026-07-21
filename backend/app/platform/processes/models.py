from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from threading import Event
from types import MappingProxyType


class ProcessOutcome(StrEnum):
    COMPLETED = "completed"
    CANCELED = "canceled"
    TIMED_OUT = "timed_out"
    FAILED_TO_START = "failed_to_start"


class CancellationToken:
    """Thread-safe cooperative cancellation signal shared with process handlers."""

    def __init__(self) -> None:
        self._event = Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)


@dataclass(frozen=True)
class ExecutableIdentity:
    """A named executable registered by trusted application wiring."""

    name: str
    path: Path
    allowed_root: Path
    sha256: str | None = None


@dataclass(frozen=True)
class ProcessSpec:
    executable: str
    argv: tuple[str, ...]
    cwd: Path
    allowed_cwd_root: Path
    timeout_seconds: float
    environment: Mapping[str, str] = field(default_factory=dict)
    inherit_environment: tuple[str, ...] = ()
    sensitive_values: tuple[str, ...] = ()
    display_name: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "environment", MappingProxyType(dict(self.environment)))


@dataclass(frozen=True)
class ProcessLogEvent:
    stream: str
    text: str
    occurred_at: datetime


@dataclass(frozen=True)
class ProcessResult:
    outcome: ProcessOutcome
    executable: str
    argv: tuple[str, ...]
    pid: int | None
    returncode: int | None
    started_at: datetime
    finished_at: datetime
    duration_seconds: float
    stdout_tail: str
    stderr_tail: str
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.outcome is ProcessOutcome.COMPLETED and self.returncode == 0
