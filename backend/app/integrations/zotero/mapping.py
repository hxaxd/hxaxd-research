from __future__ import annotations

import copy
import re
from typing import Any
from urllib.parse import urlparse

from app.catalog.models import (
    BibliographicItemDraft as CatalogItemDraft,
)
from app.catalog.models import (
    BibliographicItemView as CatalogItemView,
)
from app.catalog.models import (
    CreatorInput,
    IdentifierInput,
    LinkInput,
    TagInput,
)

from .models import (
    BibliographicCreator,
    BibliographicDate,
    BibliographicDraft,
    BibliographicIdentifier,
    BibliographicTag,
    CreatorKind,
)

_CONTAINER_FIELDS = (
    "publicationTitle",
    "proceedingsTitle",
    "bookTitle",
    "websiteTitle",
    "blogTitle",
    "forumTitle",
    "dictionaryTitle",
    "encyclopediaTitle",
    "programTitle",
    "seriesTitle",
    "university",
    "institution",
    "company",
    "studio",
    "network",
)

_KNOWN_DATA_FIELDS = {
    "key",
    "version",
    "itemType",
    "title",
    "shortTitle",
    "creators",
    "abstractNote",
    "date",
    "publisher",
    "place",
    "volume",
    "issue",
    "pages",
    "edition",
    "language",
    "rights",
    "DOI",
    "ISBN",
    "url",
    "tags",
    "collections",
    "relations",
    "extra",
    "dateAdded",
    "dateModified",
    "accessDate",
    *set(_CONTAINER_FIELDS),
}

_ARXIV_EXTRA = re.compile(r"(?im)^\s*(?:arxiv(?:\s+id)?|citation_arxiv_id)\s*:\s*([^\s;]+)")
_ARXIV_URL = re.compile(r"(?i)arxiv\.org/(?:abs|pdf)/([^?#/]+)")
_EXACT_DATE = re.compile(r"^\s*(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?\s*$")
_YEAR = re.compile(r"(?<!\d)(\d{4})(?!\d)")


def zotero_item_to_draft(item: dict[str, Any]) -> BibliographicDraft:
    """Map editable Zotero JSON to a neutral draft without discarding provider data."""

    raw = copy.deepcopy(item)
    data_value = item.get("data", item)
    if not isinstance(data_value, dict):
        raise ValueError("Zotero item data must be an object")
    data = copy.deepcopy(data_value)
    key = _text(item.get("key")) or _text(data.get("key")) or None
    version = _integer(item.get("version"))
    if version is None:
        version = _integer(data.get("version"))

    container_field, container_title = _first_text(data, _CONTAINER_FIELDS)
    url = _text(data.get("url")) or None
    extra = _text(data.get("extra")) or None

    return BibliographicDraft(
        external_key=key,
        external_version=version,
        item_type=_text(data.get("itemType")) or "document",
        title=_text(data.get("title")),
        short_title=_optional_text(data.get("shortTitle")),
        creators=_creators(data.get("creators")),
        abstract=_optional_text(data.get("abstractNote")),
        issued=_parse_date(data.get("date")),
        container_title=container_title,
        container_title_field=container_field,
        publisher=_optional_text(data.get("publisher")),
        place=_optional_text(data.get("place")),
        volume=_optional_text(data.get("volume")),
        issue=_optional_text(data.get("issue")),
        pages=_optional_text(data.get("pages")),
        edition=_optional_text(data.get("edition")),
        language=_optional_text(data.get("language")),
        rights=_optional_text(data.get("rights")),
        identifiers=_identifiers(data, url=url, extra=extra),
        url=url,
        tags=_tags(data.get("tags")),
        collections=_string_list(data.get("collections")),
        relations=_dict_or_empty(data.get("relations")),
        extra=extra,
        unknown_fields={
            key: copy.deepcopy(value)
            for key, value in data.items()
            if key not in _KNOWN_DATA_FIELDS
        },
        raw=raw,
    )


def draft_to_zotero_data(draft: BibliographicDraft, *, for_create: bool = False) -> dict[str, Any]:
    """Return editable Zotero JSON while carrying unknown source fields forward."""

    raw_data = draft.raw.get("data", draft.raw)
    result = copy.deepcopy(raw_data) if isinstance(raw_data, dict) else {}
    result.update(copy.deepcopy(draft.unknown_fields))
    result.update(
        {
            "itemType": draft.item_type,
            "title": draft.title,
            "shortTitle": draft.short_title or "",
            "creators": [_creator_to_zotero(creator) for creator in draft.creators],
            "abstractNote": draft.abstract or "",
            "date": draft.issued.literal if draft.issued else "",
            "publisher": draft.publisher or "",
            "place": draft.place or "",
            "volume": draft.volume or "",
            "issue": draft.issue or "",
            "pages": draft.pages or "",
            "edition": draft.edition or "",
            "language": draft.language or "",
            "rights": draft.rights or "",
            "url": draft.url or _identifier_value(draft, "url") or "",
            "DOI": _identifier_value(draft, "doi") or "",
            "ISBN": _identifier_value(draft, "isbn") or "",
            "tags": [_tag_to_zotero(tag) for tag in draft.tags],
            "collections": list(draft.collections),
            "relations": copy.deepcopy(draft.relations),
            "extra": _extra_with_arxiv(draft),
        }
    )
    container_field = draft.container_title_field or _default_container_field(draft.item_type)
    if draft.container_title is not None:
        result[container_field] = draft.container_title

    if for_create:
        for field in ("key", "version", "dateAdded", "dateModified"):
            result.pop(field, None)
    else:
        if draft.external_key:
            result["key"] = draft.external_key
        if draft.external_version is not None:
            result["version"] = draft.external_version
    return result


def catalog_item_to_draft(item: CatalogItemView) -> BibliographicDraft:
    """Map the v3 catalog projection to the provider-neutral synchronization shape."""

    issued_literal = item.issued_literal or _format_catalog_date(item)
    identifiers = [
        BibliographicIdentifier(
            scheme=identifier.scheme,
            value=identifier.value,
            normalized_value=identifier.normalized_value,
        )
        for identifier in item.identifiers
    ]
    url = next(
        (
            identifier.value
            for identifier in item.identifiers
            if identifier.scheme.casefold() == "url"
        ),
        None,
    ) or next((link.url for link in item.links if link.url), None)
    creators = []
    for creator in item.creators:
        if creator.creator_type == "person":
            creators.append(
                BibliographicCreator(
                    role=creator.role,
                    kind=CreatorKind.PERSON,
                    given=creator.given_name,
                    family=creator.family_name,
                )
            )
        else:
            creators.append(
                BibliographicCreator(
                    role=creator.role,
                    kind=CreatorKind.ORGANIZATION,
                    literal=creator.literal_name or creator.raw_name,
                )
            )
    return BibliographicDraft(
        item_type=_catalog_item_type_to_zotero(item.item_type),
        title=item.title,
        short_title=item.short_title,
        creators=creators,
        abstract=item.abstract,
        issued=(
            BibliographicDate(
                literal=issued_literal,
                year=item.issued_year,
                month=item.issued_month,
                day=item.issued_day,
            )
            if issued_literal
            else None
        ),
        container_title=item.container_title,
        publisher=item.publisher,
        place=item.place,
        volume=item.volume,
        issue=item.issue,
        pages=item.pages,
        edition=item.edition,
        language=item.language,
        identifiers=identifiers,
        url=url,
        tags=[
            BibliographicTag(
                name=tag.name,
                type=1 if tag.kind == "automatic" else 0,
            )
            for tag in item.tags
        ],
        raw={},
    )


def draft_to_catalog_item(draft: BibliographicDraft) -> CatalogItemDraft:
    """Map Zotero metadata into the v3 catalog command contract."""

    creators: list[CreatorInput] = []
    for creator in draft.creators:
        if creator.kind == CreatorKind.PERSON:
            raw_name = " ".join(
                part for part in (creator.given, creator.family) if (part or "").strip()
            ).strip()
            creators.append(
                CreatorInput(
                    role=creator.role,
                    creator_type="person",
                    given_name=creator.given,
                    family_name=creator.family,
                    raw_name=raw_name or creator.family or creator.given or "Unknown",
                )
            )
        else:
            literal = creator.literal or "Unknown"
            creators.append(
                CreatorInput(
                    role=creator.role,
                    creator_type="organization",
                    literal_name=literal,
                    raw_name=literal,
                )
            )
    identifiers = [
        IdentifierInput(
            scheme=identifier.scheme,
            value=identifier.value,
            is_primary=index == 0,
        )
        for index, identifier in enumerate(draft.identifiers)
    ]
    links = [LinkInput(relation_type="paper", url=draft.url)] if draft.url else []
    return CatalogItemDraft(
        item_type=_zotero_item_type_to_catalog(draft.item_type),
        title=draft.title,
        short_title=draft.short_title,
        abstract=draft.abstract,
        language=draft.language,
        issued_year=draft.issued.year if draft.issued else None,
        issued_month=draft.issued.month if draft.issued else None,
        issued_day=draft.issued.day if draft.issued else None,
        issued_literal=draft.issued.literal if draft.issued else None,
        container_title=draft.container_title,
        publisher=draft.publisher,
        place=draft.place,
        volume=draft.volume,
        issue=draft.issue,
        pages=draft.pages,
        edition=draft.edition,
        publication_state="preprint" if draft.item_type == "preprint" else "published",
        creators=creators,
        identifiers=identifiers,
        links=links,
        tags=[
            TagInput(
                name=tag.name,
                kind="automatic" if tag.type == 1 else "keyword",
            )
            for tag in draft.tags
        ],
    )


def _creators(value: Any) -> list[BibliographicCreator]:
    if not isinstance(value, list):
        return []
    creators: list[BibliographicCreator] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        raw = copy.deepcopy(entry)
        role = _text(entry.get("creatorType")) or "author"
        literal = _optional_text(entry.get("name"))
        if literal:
            creators.append(
                BibliographicCreator(
                    role=role,
                    kind=CreatorKind.ORGANIZATION,
                    literal=literal,
                    raw=raw,
                )
            )
            continue
        creators.append(
            BibliographicCreator(
                role=role,
                kind=CreatorKind.PERSON,
                given=_optional_text(entry.get("firstName")),
                family=_optional_text(entry.get("lastName")),
                raw=raw,
            )
        )
    return creators


def _creator_to_zotero(creator: BibliographicCreator) -> dict[str, Any]:
    result = copy.deepcopy(creator.raw)
    result["creatorType"] = creator.role
    if creator.kind == CreatorKind.ORGANIZATION:
        result.pop("firstName", None)
        result.pop("lastName", None)
        result["name"] = creator.literal or ""
    else:
        result.pop("name", None)
        result["firstName"] = creator.given or ""
        result["lastName"] = creator.family or ""
    return result


def _tags(value: Any) -> list[BibliographicTag]:
    if not isinstance(value, list):
        return []
    tags: list[BibliographicTag] = []
    for entry in value:
        if isinstance(entry, str):
            tags.append(BibliographicTag(name=entry, raw={"tag": entry}))
        elif isinstance(entry, dict) and _text(entry.get("tag")):
            tags.append(
                BibliographicTag(
                    name=_text(entry["tag"]),
                    type=_integer(entry.get("type")),
                    raw=copy.deepcopy(entry),
                )
            )
    return tags


def _tag_to_zotero(tag: BibliographicTag) -> dict[str, Any]:
    result = copy.deepcopy(tag.raw)
    result["tag"] = tag.name
    if tag.type is None:
        result.pop("type", None)
    else:
        result["type"] = tag.type
    return result


def _parse_date(value: Any) -> BibliographicDate | None:
    literal = _text(value)
    if not literal:
        return None
    exact = _EXACT_DATE.match(literal)
    if exact:
        year, month, day = exact.groups()
        return BibliographicDate(
            literal=literal,
            year=int(year),
            month=int(month) if month else None,
            day=int(day) if day else None,
        )
    year = _YEAR.search(literal)
    return BibliographicDate(literal=literal, year=int(year.group(1)) if year else None)


def _identifiers(
    data: dict[str, Any], *, url: str | None, extra: str | None
) -> list[BibliographicIdentifier]:
    candidates: list[tuple[str, str]] = []
    doi = _text(data.get("DOI"))
    if doi:
        candidates.append(("doi", doi))
    for isbn in _isbn_values(_text(data.get("ISBN"))):
        candidates.append(("isbn", isbn))
    arxiv = _arxiv_value(extra, url)
    if arxiv:
        candidates.append(("arxiv", arxiv))
    if url:
        candidates.append(("url", url))

    identifiers: list[BibliographicIdentifier] = []
    seen: set[tuple[str, str]] = set()
    for scheme, value in candidates:
        normalized = _normalize_identifier(scheme, value)
        key = (scheme, normalized)
        if not normalized or key in seen:
            continue
        seen.add(key)
        identifiers.append(
            BibliographicIdentifier(
                scheme=scheme,
                value=value,
                normalized_value=normalized,
            )
        )
    return identifiers


def _normalize_identifier(scheme: str, value: str) -> str:
    normalized = value.strip()
    if scheme == "doi":
        normalized = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", normalized, flags=re.I)
        return normalized.lower().rstrip(".,;)")
    if scheme == "isbn":
        return re.sub(r"[^0-9Xx]", "", normalized).upper()
    if scheme == "arxiv":
        normalized = re.sub(
            r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", normalized, flags=re.I
        )
        return re.sub(r"(?:v\d+)?(?:\.pdf)?$", "", normalized, flags=re.I).lower()
    if scheme == "url":
        parsed = urlparse(normalized)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            return ""
        return normalized.rstrip("/")
    return normalized.casefold()


def _isbn_values(value: str) -> list[str]:
    if not value:
        return []
    matches = re.findall(r"(?i)(?:97[89][\d\s-]{10,}|[\dX][\dX\s-]{8,})", value)
    return [match.strip(" ,;") for match in matches] or [value]


def _arxiv_value(extra: str | None, url: str | None) -> str | None:
    if extra:
        match = _ARXIV_EXTRA.search(extra)
        if match:
            return match.group(1)
    if url:
        match = _ARXIV_URL.search(url)
        if match:
            return match.group(1)
    return None


def _identifier_value(draft: BibliographicDraft, scheme: str) -> str | None:
    return next((item.value for item in draft.identifiers if item.scheme == scheme), None)


def _extra_with_arxiv(draft: BibliographicDraft) -> str:
    extra = draft.extra or ""
    arxiv = _identifier_value(draft, "arxiv")
    if arxiv and not _ARXIV_EXTRA.search(extra):
        return f"{extra.rstrip()}\narXiv: {arxiv}".lstrip()
    return extra


def _default_container_field(item_type: str) -> str:
    return {
        "journalArticle": "publicationTitle",
        "conferencePaper": "proceedingsTitle",
        "bookSection": "bookTitle",
        "webpage": "websiteTitle",
        "blogPost": "blogTitle",
        "forumPost": "forumTitle",
        "thesis": "university",
        "report": "institution",
    }.get(item_type, "publicationTitle")


def _first_text(data: dict[str, Any], fields: tuple[str, ...]) -> tuple[str | None, str | None]:
    for field in fields:
        value = _optional_text(data.get(field))
        if value is not None:
            return field, value
    return None, None


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _optional_text(value: Any) -> str | None:
    return _text(value) or None


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, str)]


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _format_catalog_date(item: CatalogItemView) -> str | None:
    if item.issued_year is None:
        return None
    value = f"{item.issued_year:04d}"
    if item.issued_month is not None:
        value += f"-{item.issued_month:02d}"
    if item.issued_day is not None:
        value += f"-{item.issued_day:02d}"
    return value


def _catalog_item_type_to_zotero(item_type: str) -> str:
    return {
        "article": "journalArticle",
        "journal_article": "journalArticle",
        "conference_paper": "conferencePaper",
        "book_chapter": "bookSection",
        "web_page": "webpage",
    }.get(item_type, item_type)


def _zotero_item_type_to_catalog(item_type: str) -> str:
    return {
        "journalArticle": "journal_article",
        "conferencePaper": "conference_paper",
        "bookSection": "book_chapter",
        "webpage": "web_page",
    }.get(item_type, item_type)
