from __future__ import annotations

from fastapi import APIRouter

from app.modules.papers.router import router as papers_router
from app.modules.projects.router import router as projects_router
from app.modules.resources.router import router as resources_router
from app.modules.snapshots.router import router as snapshots_router
from app.modules.tools.router import router as tools_router
from app.modules.translations.router import router as translations_router
from app.modules.workspace.router import router as workspace_router

from .health import router as health_router

api_router = APIRouter(prefix="/api")
api_router.include_router(health_router)
api_router.include_router(projects_router)
api_router.include_router(papers_router)
api_router.include_router(resources_router)
api_router.include_router(translations_router)
api_router.include_router(tools_router)
api_router.include_router(workspace_router)
api_router.include_router(snapshots_router)
