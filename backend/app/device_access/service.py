from __future__ import annotations

import ipaddress
import secrets
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from threading import Lock

from .models import DeviceSession, PairDeviceRequest, PairingCreate, PairingTicket
from .repository import DeviceAccessRepository, PairingCodeError

_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


class PairingRateLimitError(RuntimeError):
    pass


class DeviceAccessService:
    def __init__(
        self,
        repository: DeviceAccessRepository,
        *,
        lan_enabled: bool,
        session_days: int = 90,
    ) -> None:
        self.repository = repository
        self.lan_enabled = lan_enabled
        self.session_days = session_days
        self._failed_attempts: dict[str, deque[datetime]] = defaultdict(deque)
        self._attempt_lock = Lock()

    @staticmethod
    def is_local_client(host: str | None) -> bool:
        if not host or host == "testclient":
            return True
        try:
            return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
        except ValueError:
            return host.casefold() == "localhost"

    def create_pairing(self, payload: PairingCreate) -> PairingTicket:
        if not self.lan_enabled:
            raise RuntimeError("局域网访问尚未显式启用")
        raw = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        pairing_id, expires_at = self.repository.create_pairing(
            code=_normalize_code(code),
            label=payload.label,
            ttl_seconds=payload.ttl_seconds,
        )
        return PairingTicket(id=pairing_id, code=code, expires_at=expires_at)

    def pair(
        self,
        payload: PairDeviceRequest,
        *,
        client_key: str,
        user_agent: str | None,
    ) -> tuple[str, DeviceSession]:
        self._check_rate_limit(client_key)
        try:
            result = self.repository.claim_pairing(
                code=_normalize_code(payload.code),
                label=payload.label,
                user_agent=user_agent,
                session_days=self.session_days,
            )
        except PairingCodeError:
            self._record_failure(client_key)
            raise
        self._clear_failures(client_key)
        return result

    def authenticate(self, token: str | None) -> DeviceSession | None:
        if not token:
            return None
        return self.repository.session_for_token(token)

    def sessions(self, current_session_id: str | None) -> list[DeviceSession]:
        return self.repository.list_sessions(current_session_id)

    def revoke(self, session_id: str) -> DeviceSession:
        return self.repository.revoke_session(session_id)

    def _check_rate_limit(self, client_key: str) -> None:
        cutoff = datetime.now(UTC) - timedelta(minutes=1)
        with self._attempt_lock:
            attempts = self._failed_attempts[client_key]
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            if len(attempts) >= 5:
                raise PairingRateLimitError("配对尝试过多，请一分钟后重试")

    def _record_failure(self, client_key: str) -> None:
        with self._attempt_lock:
            self._failed_attempts[client_key].append(datetime.now(UTC))

    def _clear_failures(self, client_key: str) -> None:
        with self._attempt_lock:
            self._failed_attempts.pop(client_key, None)


def _normalize_code(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())
