from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

IDENTITY_SCHEMES = {"arxiv", "doi", "openreview", "pmid", "pubmed"}


class CatalogError(RuntimeError):
    pass


class CatalogNotFoundError(CatalogError):
    pass


class CatalogConflictError(CatalogError):
    pass


@dataclass(frozen=True)
class NormalizedIdentifier:
    scheme: str
    value: str
    normalized_value: str
    version: str | None
    is_identity: bool


def normalize_identifier(scheme: str, value: str) -> NormalizedIdentifier:
    normalized_scheme = scheme.strip().lower()
    raw_value = value.strip()
    if not normalized_scheme or not raw_value:
        raise CatalogConflictError("identifier scheme and value are required")
    version: str | None = None
    if normalized_scheme == "doi":
        normalized = re.sub(
            r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", raw_value, flags=re.I
        ).lower()
        normalized = normalized.rstrip(".,;)")
    elif normalized_scheme == "arxiv":
        normalized = re.sub(
            r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:)", "", raw_value, flags=re.I
        )
        normalized = re.sub(r"\.pdf$", "", normalized, flags=re.I)
        match = re.fullmatch(r"(.+?)(v\d+)?", normalized, flags=re.I)
        if match is None:
            raise CatalogConflictError("invalid arXiv identifier")
        normalized = match.group(1).lower()
        version = match.group(2).lower() if match.group(2) else None
    elif normalized_scheme == "url":
        parsed = urlsplit(raw_value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            raise CatalogConflictError("URL identifier must be absolute HTTP(S)")
        normalized = urlunsplit(
            (
                parsed.scheme.lower(),
                parsed.netloc.lower(),
                parsed.path.rstrip("/") or "/",
                parsed.query,
                "",
            )
        )
    else:
        normalized = raw_value.casefold()
    if not normalized:
        raise CatalogConflictError("identifier is empty after normalization")
    return NormalizedIdentifier(
        scheme=normalized_scheme,
        value=raw_value,
        normalized_value=normalized,
        version=version,
        is_identity=normalized_scheme in IDENTITY_SCHEMES,
    )
