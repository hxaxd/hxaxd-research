from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.router import create_api_router
from app.core.bootstrap import build_app_context
from app.core.config import Settings
from app.core.frontend import mount_frontend
from app.core.http_errors import register_error_handlers
from app.device_access.middleware import DeviceAccessMiddleware
from app.platform import WorkspaceMutationGate


class WorkspaceConcurrencyMiddleware:
    def __init__(self, app: ASGIApp, *, gate: WorkspaceMutationGate) -> None:
        self.app = app
        self.gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path", ""))
        if path == "/api/health" or path.endswith("/events"):
            await self.app(scope, receive, send)
            return
        method = str(scope.get("method", "GET")).upper()
        is_read = method in {"GET", "HEAD", "OPTIONS"}
        entered = self.gate.enter_read() if is_read else self.gate.enter_mutation()
        if not entered:
            response = JSONResponse(
                status_code=503,
                content={
                    "code": "workspace_maintenance",
                    "message": "工作区正在创建或恢复快照，请稍后重试",
                    "details": None,
                },
                headers={"Retry-After": "2"},
            )
            await response(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            if is_read:
                self.gate.exit_read()
            else:
                self.gate.exit_mutation()


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.from_environment()
    context = build_app_context(active_settings)
    mcp_application = context.mcp_server.streamable_http_app()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        context.startup()
        try:
            async with context.mcp_server.session_manager.run():
                yield
        finally:
            context.shutdown()

    application = FastAPI(
        title="Hxaxd Literature Workspace API",
        description=("文献元数据、候选判断、附件、持久任务、内嵌代理与集成的唯一服务接口。"),
        version="4.0.0",
        lifespan=lifespan,
    )
    application.state.context = context
    application.state.workspace_database = context.database
    application.state.zotero_service = context.zotero_service

    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(active_settings.frontend_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.add_middleware(WorkspaceConcurrencyMiddleware, gate=context.mutation_gate)
    if active_settings.lan_access_enabled:
        application.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=list(active_settings.allowed_hosts),
        )
    application.add_middleware(
        DeviceAccessMiddleware,
        service=context.device_access,
        public_origin=active_settings.public_base_url,
    )
    register_error_handlers(application)
    application.include_router(create_api_router(context))
    application.mount("/mcp", mcp_application)
    mount_frontend(application, active_settings.frontend_dist_dir)
    return application


app = create_app()
