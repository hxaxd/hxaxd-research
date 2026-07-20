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
        title="Hxaxd Learning Workspace API",
        description=(
            "学习项目、论文事实、项目判断、PDF/TeX 资源、转换任务和本地工具的唯一服务接口。"
            "交互式文档位于 /docs，机器可读契约位于 /openapi.json。"
        ),
        version="0.3.0",
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
