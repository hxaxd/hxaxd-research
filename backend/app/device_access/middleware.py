from __future__ import annotations

from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .models import DevicePrincipal
from .service import DeviceAccessService

DEVICE_SESSION_COOKIE = "hxaxd_device_session"
_PUBLIC_API_PATHS = {
    "/api/device-access/status",
    "/api/device-access/pair",
    "/api/health",
}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_PRIVATE_SCHEMA_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


class DeviceAccessMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        service: DeviceAccessService,
        public_origin: str,
    ) -> None:
        self.app = app
        self.service = service
        self.public_origin = public_origin.rstrip("/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        host = scope.get("client", (None, None))[0]
        local = self.service.is_local_client(str(host) if host else None)
        path = str(scope.get("path", ""))
        method = str(scope.get("method", "GET")).upper()
        if local:
            scope.setdefault("state", {})["device_principal"] = DevicePrincipal(
                local_request=True,
                authenticated=True,
            )
            await self.app(scope, receive, send)
            return
        if not self.service.lan_enabled:
            await _error(403, "lan_access_disabled", "局域网访问没有启用")(scope, receive, send)
            return
        if path.startswith("/mcp"):
            await _error(403, "remote_mcp_forbidden", "远程设备不能访问智能体工具端点")(
                scope, receive, send
            )
            return
        if path in _PRIVATE_SCHEMA_PATHS:
            await _error(403, "remote_schema_forbidden", "远程设备不能访问内部接口说明")(
                scope, receive, send
            )
            return
        if method not in _SAFE_METHODS and not self._same_origin(scope):
            await _error(403, "cross_site_request_rejected", "远程写请求必须来自工作台自身")(
                scope, receive, send
            )
            return
        token = _cookie(scope, DEVICE_SESSION_COOKIE)
        session = self.service.authenticate(token)
        principal = DevicePrincipal(
            local_request=False,
            authenticated=session is not None,
            session_id=session.id if session else None,
        )
        scope.setdefault("state", {})["device_principal"] = principal
        if path in _PUBLIC_API_PATHS or (method in _SAFE_METHODS and not path.startswith("/api")):
            await self.app(scope, receive, send)
            return
        if session is None:
            await _error(401, "device_pairing_required", "此设备需要先与本机配对")(
                scope, receive, send
            )
            return
        await self.app(scope, receive, send)

    def _same_origin(self, scope: Scope) -> bool:
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        origin = headers.get(b"origin", b"").decode("latin-1").rstrip("/")
        host = headers.get(b"host", b"").decode("latin-1").casefold()
        if not origin or not host:
            return False
        parsed = urlsplit(origin)
        return parsed.scheme in {"http", "https"} and parsed.netloc.casefold() == host


def _cookie(scope: Scope, name: str) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() != b"cookie":
            continue
        parsed = SimpleCookie()
        try:
            parsed.load(value.decode("latin-1"))
        except Exception:
            return None
        morsel = parsed.get(name)
        return morsel.value if morsel else None
    return None


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message, "details": None},
    )
