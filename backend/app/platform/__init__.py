"""Shared infrastructure used by the domain-oriented application modules."""

from .activation import (
    ActivationError,
    FaultInjector,
    activate_snapshot_directory,
    default_activation_journal,
    ensure_no_activation_residue,
    recover_pending_activation,
)
from .concurrency import (
    WorkspaceBusyError,
    WorkspaceMutationGate,
    WorkspaceProcessLock,
)

__all__ = [
    "ActivationError",
    "FaultInjector",
    "WorkspaceBusyError",
    "WorkspaceMutationGate",
    "WorkspaceProcessLock",
    "activate_snapshot_directory",
    "default_activation_journal",
    "ensure_no_activation_residue",
    "recover_pending_activation",
]
