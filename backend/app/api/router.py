from __future__ import annotations

from fastapi import APIRouter

from app.modules.artifacts.router import router as artifacts_router
from app.modules.papers.router import router as papers_router
from app.modules.projects.router import router as projects_router
from app.modules.translations.router import router as translations_router

from .health import router as health_router

api_router = APIRouter(prefix="/api")
api_router.include_router(health_router)
api_router.include_router(projects_router)
api_router.include_router(papers_router)
api_router.include_router(artifacts_router)
api_router.include_router(translations_router)
