from __future__ import annotations

import pytest

from app.platform import WorkspaceBusyError, WorkspaceMutationGate, WorkspaceProcessLock


def test_process_lock_rejects_a_second_backend_and_can_be_reacquired(tmp_path) -> None:
    path = tmp_path / ".runtime" / "workspace.lock"
    first = WorkspaceProcessLock(path)
    second = WorkspaceProcessLock(path)
    first.acquire()
    try:
        with pytest.raises(WorkspaceBusyError):
            second.acquire()
    finally:
        first.release()

    second.acquire()
    second.release()


def test_maintenance_gate_rejects_new_mutations_and_recovers() -> None:
    gate = WorkspaceMutationGate()
    assert gate.enter_mutation()
    gate.exit_mutation()
    with gate.maintenance():
        assert gate.maintenance_active
        assert not gate.enter_mutation()
        assert gate.enter_read()
        gate.exit_read()
    with gate.maintenance(block_reads=True):
        assert not gate.enter_read()
        assert not gate.enter_mutation()
    assert gate.enter_mutation()
    gate.exit_mutation()
