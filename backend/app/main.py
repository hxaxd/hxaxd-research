from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.bootstrap import build_app_context
from app.core.config import Settings
from app.core.http_errors import register_error_handlers


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.from_environment()
    context = build_app_context(active_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        context.startup()
        yield
        context.shutdown()

    application = FastAPI(
        title="Hxaxd Research API",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.state.context = context
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(active_settings.frontend_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(application)
    application.include_router(api_router)
    return application


app = create_app()
