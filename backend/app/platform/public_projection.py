from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_HTTP_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_WINDOWS_PATH = re.compile(
    r"(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n\t\"'<>|]+"
)
_FILE_URL = re.compile(r"file://[^\s<>\"']+", re.IGNORECASE)
_UNIX_PATH = re.compile(
    r"(?<![\w])/(?:Users|home|root|tmp|var|opt|mnt|srv|private)/[^\s<>\"']+"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?P<label>\b(?:access[_-]?token|refresh[_-]?token|bearer[_-]?token|"
    r"api[_-]?key|session[_-]?token|write[_-]?token|token|password|secret|"
    r"authorization|cookie|credential)\b\s*[:=]\s*)"
    r"(?:Bearer\s+)?(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)

_PRIVATE_FIELD_NAMES = frozenset(
    {
        "argv",
        "command",
        "concurrency_key",
        "context_hash",
        "cwd",
        "env",
        "environment",
        "executable",
        "executable_path",
        "heartbeat_at",
        "idempotency_key",
        "input",
        "install_path",
        "lease_expires_at",
        "lease_owner",
        "path",
        "process_id",
        "prompt",
        "provider_request_id",
        "provider_call_id",
        "provider_item_id",
        "provider_thread_id",
        "provider_tool_call_id",
        "provider_turn_id",
        "result",
        "storage_key",
        "thread_id",
        "turn_id",
        "worker_id",
        "attempt_id",
    }
)
_SECRET_FIELD_NAMES = frozenset(
    {
        "access_token",
        "api_key",
        "auth",
        "authorization",
        "bearer_token",
        "cookie",
        "credential",
        "credentials",
        "password",
        "refresh_token",
        "secret",
        "session_token",
        "token",
        "write_token",
    }
)
_SENSITIVE_QUERY_NAMES = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "auth",
        "authorization",
        "code",
        "cookie",
        "credential",
        "key",
        "password",
        "refresh_token",
        "secret",
        "session",
        "session_token",
        "sig",
        "signature",
        "token",
        "x_amz_credential",
        "x_amz_security_token",
        "x_amz_signature",
        "x_goog_credential",
        "x_goog_signature",
    }
)


def sanitize_public_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Return browser-safe event/approval data without mutating persisted evidence."""

    return _sanitize_mapping(payload, depth=0)


def sanitize_public_text(value: str | None) -> str | None:
    if value is None:
        return None
    sanitized = _HTTP_URL.sub(_sanitize_url_match, value)
    sanitized = _SECRET_ASSIGNMENT.sub(r"\g<label>[REDACTED]", sanitized)
    sanitized = _FILE_URL.sub("[REDACTED_PATH]", sanitized)
    sanitized = _WINDOWS_PATH.sub("[REDACTED_PATH]", sanitized)
    return _UNIX_PATH.sub("[REDACTED_PATH]", sanitized)


def sanitize_public_url(value: str) -> str:
    """Remove credentials and sensitive query parameters from a public URL."""

    try:
        parsed = urlsplit(value)
    except ValueError:
        return "[REDACTED_URL]"
    if parsed.scheme and parsed.scheme.lower() not in {"http", "https"}:
        return "[REDACTED_URL]"
    if parsed.scheme:
        hostname = parsed.hostname
        if not hostname:
            return "[REDACTED_URL]"
        host = f"[{hostname}]" if ":" in hostname else hostname
        try:
            port = parsed.port
        except ValueError:
            return "[REDACTED_URL]"
        netloc = f"{host}:{port}" if port is not None else host
    else:
        netloc = parsed.netloc
    safe_query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if _normalized_name(key) not in _SENSITIVE_QUERY_NAMES
    ]
    return urlunsplit(
        (parsed.scheme, netloc, parsed.path, urlencode(safe_query, doseq=True), "")
    )


def _sanitize_mapping(value: dict[str, Any], *, depth: int) -> dict[str, Any]:
    if depth > 20:
        return {}
    result: dict[str, Any] = {}
    for key, item in value.items():
        normalized = _normalized_name(key)
        if normalized in _PRIVATE_FIELD_NAMES or normalized in _SECRET_FIELD_NAMES:
            continue
        result[key] = _sanitize_value(item, depth=depth + 1)
    return result


def _sanitize_value(value: Any, *, depth: int) -> Any:
    if depth > 20:
        return None
    if isinstance(value, dict):
        return _sanitize_mapping(value, depth=depth)
    if isinstance(value, (list, tuple)):
        return [_sanitize_value(item, depth=depth + 1) for item in value]
    if isinstance(value, str):
        if value.startswith(("http://", "https://")):
            return sanitize_public_url(value)
        if value.startswith("/") and "?" in value:
            return sanitize_public_url(value)
        return sanitize_public_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return sanitize_public_text(str(value))


def _sanitize_url_match(match: re.Match[str]) -> str:
    value = match.group(0)
    trailing = ""
    while value and value[-1] in ".,;:!?)]}":
        trailing = value[-1] + trailing
        value = value[:-1]
    return sanitize_public_url(value) + trailing


def _normalized_name(value: str) -> str:
    snake = _CAMEL_BOUNDARY.sub("_", value).replace("-", "_")
    return snake.casefold()
