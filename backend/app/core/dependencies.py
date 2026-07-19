from __future__ import annotations

from fastapi import Request

from .bootstrap import AppContext


def get_app_context(request: Request) -> AppContext:
    return request.app.state.context
