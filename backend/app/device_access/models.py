from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _DeviceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DevicePrincipal(_DeviceModel):
    local_request: bool
    authenticated: bool
    session_id: str | None = None


class DeviceAccessStatus(_DeviceModel):
    lan_enabled: bool
    local_request: bool
    authenticated: bool
    pairing_required: bool
    session_id: str | None = None
    cookie_secure: bool


class PairingCreate(_DeviceModel):
    label: str | None = Field(default=None, max_length=120)
    ttl_seconds: int = Field(default=600, ge=60, le=900)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str | None) -> str | None:
        stripped = value.strip() if value else ""
        return stripped or None


class PairingTicket(_DeviceModel):
    id: str
    code: str
    expires_at: datetime


class PairDeviceRequest(_DeviceModel):
    code: str = Field(min_length=8, max_length=20)
    label: str = Field(min_length=1, max_length=120)

    @field_validator("code", "label")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return value.strip()


class DeviceSession(_DeviceModel):
    id: str
    label: str
    user_agent: str | None
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    current: bool = False


class PairedDevice(_DeviceModel):
    status: DeviceAccessStatus
    session: DeviceSession
