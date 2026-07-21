from __future__ import annotations

import os
import sys
from pathlib import Path
from threading import Thread
from time import sleep

import pytest

from app.platform.processes import (
    CancellationToken,
    ExecutableIdentity,
    ExecutableRegistry,
    ProcessOutcome,
    ProcessPolicyError,
    ProcessRunner,
    ProcessSpec,
)


def _runner() -> ProcessRunner:
    executable = Path(sys.executable).resolve()
    registry = ExecutableRegistry((ExecutableIdentity("python", executable, executable.parent),))
    return ProcessRunner(
        registry,
        environment_source={"ALLOWED_SOURCE": "visible", "FORBIDDEN_SOURCE": "hidden"},
        allowed_environment=frozenset({"ALLOWED_SOURCE", "APP_SECRET"}),
    )


def test_runner_uses_allowlisted_environment_and_redacts_logs(tmp_path):
    events = []
    result = _runner().run(
        ProcessSpec(
            executable="python",
            argv=(
                "-c",
                "import os; print(os.getenv('ALLOWED_SOURCE')); "
                "print(os.getenv('FORBIDDEN_SOURCE')); print(os.getenv('APP_SECRET'))",
            ),
            cwd=tmp_path,
            allowed_cwd_root=tmp_path,
            timeout_seconds=5,
            inherit_environment=("ALLOWED_SOURCE",),
            environment={"APP_SECRET": "top-secret"},
        ),
        observer=events.append,
    )

    assert result.succeeded
    assert "visible" in result.stdout_tail
    assert "hidden" not in result.stdout_tail
    assert "top-secret" not in result.stdout_tail
    assert "[REDACTED]" in result.stdout_tail
    assert all("top-secret" not in event.text for event in events)


def test_runner_times_out_and_cancels_processes(tmp_path):
    runner = _runner()
    timed_out = runner.run(
        ProcessSpec(
            executable="python",
            argv=("-c", "import time; time.sleep(10)"),
            cwd=tmp_path,
            allowed_cwd_root=tmp_path,
            timeout_seconds=0.15,
        )
    )
    assert timed_out.outcome is ProcessOutcome.TIMED_OUT

    token = CancellationToken()
    results = []
    thread = Thread(
        target=lambda: results.append(
            runner.run(
                ProcessSpec(
                    executable="python",
                    argv=("-c", "import time; time.sleep(10)"),
                    cwd=tmp_path,
                    allowed_cwd_root=tmp_path,
                    timeout_seconds=20,
                ),
                cancellation=token,
            )
        )
    )
    thread.start()
    sleep(0.1)
    token.cancel()
    thread.join(timeout=5)
    assert results[0].outcome is ProcessOutcome.CANCELED


def test_runner_rejects_unregistered_executable_and_cwd_escape(tmp_path):
    runner = _runner()
    with pytest.raises(ProcessPolicyError, match="unregistered"):
        runner.run(
            ProcessSpec(
                executable="other",
                argv=(),
                cwd=tmp_path,
                allowed_cwd_root=tmp_path,
                timeout_seconds=1,
            )
        )

    outside = tmp_path.parent
    with pytest.raises(ProcessPolicyError, match="working directory"):
        runner.run(
            ProcessSpec(
                executable="python",
                argv=(),
                cwd=outside,
                allowed_cwd_root=tmp_path,
                timeout_seconds=1,
            )
        )


@pytest.mark.skipif(os.name != "nt", reason="Windows process flags are platform-specific")
def test_windows_processes_are_hidden_and_grouped(tmp_path):
    result = _runner().run(
        ProcessSpec(
            executable="python",
            argv=("-c", "print('ok')"),
            cwd=tmp_path,
            allowed_cwd_root=tmp_path,
            timeout_seconds=5,
        )
    )
    assert result.succeeded
