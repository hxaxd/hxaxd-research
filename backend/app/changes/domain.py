class ChangeSetNotFoundError(LookupError):
    pass


class ChangeSetConflictError(RuntimeError):
    pass


class ChangeSetApplyError(RuntimeError):
    pass
