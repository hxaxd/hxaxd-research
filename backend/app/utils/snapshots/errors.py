class SnapshotError(RuntimeError):
    """Raised when a snapshot cannot be created or restored safely."""


class SnapshotCancelled(SnapshotError):
    """Raised when a snapshot operation observes cooperative cancellation."""
