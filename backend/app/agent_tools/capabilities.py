from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from threading import RLock

from mcp.server.auth.provider import AccessToken


@dataclass(frozen=True, slots=True)
class CapabilityGrant:
    run_id: str
    project_id: str | None
    scopes: frozenset[str]
    expires_at: int


class AgentCapabilityRegistry:
    """Issues short-lived, in-memory bearer tokens for one isolated agent run."""

    def __init__(self, *, default_ttl_seconds: int = 4_000) -> None:
        self.default_ttl_seconds = default_ttl_seconds
        self._grants: dict[str, CapabilityGrant] = {}
        self._run_tokens: dict[str, set[str]] = {}
        self._lock = RLock()

    def issue(
        self,
        run_id: str,
        *,
        project_id: str | None,
        scopes: frozenset[str],
        ttl_seconds: int | None = None,
    ) -> str:
        token = secrets.token_urlsafe(48)
        digest = self._digest(token)
        grant = CapabilityGrant(
            run_id=run_id,
            project_id=project_id,
            scopes=scopes,
            expires_at=int(time.time()) + (ttl_seconds or self.default_ttl_seconds),
        )
        with self._lock:
            self._grants[digest] = grant
            self._run_tokens.setdefault(run_id, set()).add(digest)
        return token

    def revoke_run(self, run_id: str) -> None:
        with self._lock:
            for digest in self._run_tokens.pop(run_id, set()):
                self._grants.pop(digest, None)

    async def verify_token(self, token: str) -> AccessToken | None:
        digest = self._digest(token)
        with self._lock:
            grant = self._grants.get(digest)
            if grant is not None and grant.expires_at <= int(time.time()):
                self._grants.pop(digest, None)
                self._run_tokens.get(grant.run_id, set()).discard(digest)
                grant = None
        if grant is None:
            return None
        return AccessToken(
            token=token,
            client_id=f"agent-run:{grant.run_id}",
            subject=grant.run_id,
            scopes=sorted(grant.scopes),
            expires_at=grant.expires_at,
            claims={
                "run_id": grant.run_id,
                "project_id": grant.project_id,
            },
        )

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()
