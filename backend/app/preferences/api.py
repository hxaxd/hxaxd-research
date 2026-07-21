from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from .models import UserPreferences, UserPreferencesUpdate
from .repository import PreferencesConflictError
from .service import PreferencesService

router = APIRouter(tags=["preferences"])


def get_service(request: Request) -> PreferencesService:
    return request.app.state.context.preferences


@router.get("/user-preferences", response_model=UserPreferences)
def get_user_preferences(
    service: Annotated[PreferencesService, Depends(get_service)],
) -> UserPreferences:
    return service.get()


@router.put("/user-preferences", response_model=UserPreferences)
def update_user_preferences(
    payload: UserPreferencesUpdate,
    service: Annotated[PreferencesService, Depends(get_service)],
) -> UserPreferences:
    try:
        return service.update(payload)
    except PreferencesConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
