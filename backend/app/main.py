"""FastAPI application factory and composition root."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import build_router
from .config import Settings, load_settings
from .projects.service import ProjectService
from .projects.store import ProjectStore

DESCRIPTION = (
    "项目工作台后端:代管项目目录并登记项目与 DSH 工作区的对应关系。"
    "会话与文件由上游 DSH 服务保存,本服务不复制聊天历史。"
)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Compose one application instance; the only wiring point."""
    settings = settings or load_settings()
    store = ProjectStore(settings.registry_path)
    service = ProjectService(
        store=store,
        projects_root=settings.projects_root,
    )

    app = FastAPI(
        title="hxaxd-research-backend",
        description=DESCRIPTION,
        version="0.1.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type"],
    )
    app.include_router(build_router(service))
    return app


app = create_app()
