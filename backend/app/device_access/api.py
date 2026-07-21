from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .middleware import DEVICE_SESSION_COOKIE
from .models import (
    DeviceAccessStatus,
    DevicePrincipal,
    DeviceSession,
    PairDeviceRequest,
    PairedDevice,
    PairingCreate,
    PairingTicket,
)
from .repository import DeviceSessionNotFoundError, PairingCodeError
from .service import DeviceAccessService, PairingRateLimitError

router = APIRouter(prefix="/device-access", tags=["device-access"])


def get_service(request: Request) -> DeviceAccessService:
    return request.app.state.context.device_access


def principal(request: Request) -> DevicePrincipal:
    return getattr(
        request.state,
        "device_principal",
        DevicePrincipal(local_request=True, authenticated=True),
    )


def _status(request: Request, service: DeviceAccessService) -> DeviceAccessStatus:
    identity = principal(request)
    return DeviceAccessStatus(
        lan_enabled=service.lan_enabled,
        local_request=identity.local_request,
        authenticated=identity.authenticated,
        pairing_required=(
            service.lan_enabled and not identity.local_request and not identity.authenticated
        ),
        session_id=identity.session_id,
        cookie_secure=request.app.state.context.settings.device_cookie_secure,
    )


@router.get("/status", response_model=DeviceAccessStatus)
def status(
    request: Request,
    service: Annotated[DeviceAccessService, Depends(get_service)],
) -> DeviceAccessStatus:
    return _status(request, service)


@router.post("/pairings", response_model=PairingTicket, status_code=201)
def create_pairing(
    payload: PairingCreate,
    request: Request,
    service: Annotated[DeviceAccessService, Depends(get_service)],
) -> PairingTicket:
    if not principal(request).local_request:
        raise HTTPException(status_code=403, detail="配对码只能在运行后端的电脑上生成")
    try:
        return service.create_pairing(payload)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/pair", response_model=PairedDevice)
def pair_device(
    payload: PairDeviceRequest,
    request: Request,
    response: Response,
    service: Annotated[DeviceAccessService, Depends(get_service)],
) -> PairedDevice:
    client_key = request.client.host if request.client else "unknown"
    try:
        token, session = service.pair(
            payload,
            client_key=client_key,
            user_agent=request.headers.get("user-agent"),
        )
    except PairingCodeError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except PairingRateLimitError as error:
        raise HTTPException(
            status_code=429,
            detail=str(error),
            headers={"Retry-After": "60"},
        ) from error
    response.set_cookie(
        DEVICE_SESSION_COOKIE,
        token,
        httponly=True,
        secure=request.app.state.context.settings.device_cookie_secure,
        samesite="strict",
        max_age=service.session_days * 24 * 60 * 60,
        path="/",
    )
    identity = DevicePrincipal(
        local_request=False,
        authenticated=True,
        session_id=session.id,
    )
    request.state.device_principal = identity
    paired_status = DeviceAccessStatus(
        lan_enabled=True,
        local_request=False,
        authenticated=True,
        pairing_required=False,
        session_id=session.id,
        cookie_secure=request.app.state.context.settings.device_cookie_secure,
    )
    return PairedDevice(status=paired_status, session=session.model_copy(update={"current": True}))


@router.get("/sessions", response_model=list[DeviceSession])
def sessions(
    request: Request,
    service: Annotated[DeviceAccessService, Depends(get_service)],
) -> list[DeviceSession]:
    return service.sessions(principal(request).session_id)


@router.delete("/sessions/{session_id}", response_model=DeviceSession)
def revoke_session(
    session_id: str,
    request: Request,
    response: Response,
    service: Annotated[DeviceAccessService, Depends(get_service)],
) -> DeviceSession:
    try:
        revoked = service.revoke(session_id)
    except DeviceSessionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if principal(request).session_id == session_id:
        response.delete_cookie(DEVICE_SESSION_COOKIE, path="/", samesite="strict")
    return revoked.model_copy(update={"current": principal(request).session_id == session_id})
