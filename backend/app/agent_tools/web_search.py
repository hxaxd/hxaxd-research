from __future__ import annotations

import html
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree

WebSearchIntent = Literal["academic", "metadata", "open_access"]

_CROSSREF_ENDPOINT = "https://api.crossref.org/works"
_ARXIV_ENDPOINT = "https://export.arxiv.org/api/query"
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_QUERY_CHARACTERS = 500
_MAX_RESULTS = 20
_HTML_TAG = re.compile(r"<[^>]+>")
_WHITESPACE = re.compile(r"\s+")
_ARXIV_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}


class WebSearchError(RuntimeError):
    """Base error exposed through the MCP tool without leaking response bodies."""


class WebSearchProviderError(WebSearchError):
    def __init__(self, provider: str, code: str) -> None:
        super().__init__(f"{provider} search failed: {code}")
        self.provider = provider
        self.code = code


class WebSearchUnavailableError(WebSearchError):
    pass


@dataclass(frozen=True, slots=True)
class FetchResponse:
    status: int
    body: bytes


Fetch = Callable[[str, float], FetchResponse]


class LiteratureWebSearch:
    """Keyless, deterministic literature search over fixed scholarly endpoints."""

    def __init__(self, *, fetch: Fetch | None = None, timeout_seconds: float = 10.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("web search timeout must be positive")
        self.fetch = fetch or _fetch
        self.timeout_seconds = timeout_seconds

    def search(
        self,
        query: str,
        *,
        limit: int = 8,
        intent: WebSearchIntent = "academic",
        from_year: int | None = None,
        to_year: int | None = None,
    ) -> dict[str, Any]:
        normalized_query = _WHITESPACE.sub(" ", query).strip()
        if not normalized_query:
            raise ValueError("web search query cannot be empty")
        if len(normalized_query) > _MAX_QUERY_CHARACTERS:
            raise ValueError(
                f"web search query cannot exceed {_MAX_QUERY_CHARACTERS} characters"
            )
        if not 1 <= limit <= _MAX_RESULTS:
            raise ValueError(f"web search limit must be between 1 and {_MAX_RESULTS}")
        if from_year is not None and not 1000 <= from_year <= 3000:
            raise ValueError("from_year is outside the supported range")
        if to_year is not None and not 1000 <= to_year <= 3000:
            raise ValueError("to_year is outside the supported range")
        if from_year is not None and to_year is not None and from_year > to_year:
            raise ValueError("from_year cannot be later than to_year")

        providers: list[dict[str, Any]] = []
        found: list[dict[str, Any]] = []
        searches = (
            ("crossref", self._crossref),
            ("arxiv", self._arxiv),
        )
        for provider, search in searches:
            try:
                results = search(
                    normalized_query,
                    limit=limit,
                    from_year=from_year,
                    to_year=to_year,
                )
            except WebSearchProviderError as error:
                providers.append(
                    {"name": provider, "status": "failed", "error_code": error.code}
                )
            else:
                providers.append(
                    {"name": provider, "status": "completed", "result_count": len(results)}
                )
                found.extend(results)

        if not any(provider["status"] == "completed" for provider in providers):
            summary = ", ".join(
                f"{provider['name']}={provider['error_code']}" for provider in providers
            )
            raise WebSearchUnavailableError(f"all literature search providers failed: {summary}")

        deduplicated = _deduplicate(found)
        if intent == "open_access":
            deduplicated.sort(
                key=lambda result: (
                    result.get("pdf_url") is None,
                    not result.get("open_access", False),
                    -(result.get("publication_year") or 0),
                )
            )
        elif intent == "metadata":
            deduplicated.sort(
                key=lambda result: (
                    result.get("doi") is None,
                    result["source"] != "crossref",
                    -(result.get("publication_year") or 0),
                )
            )

        return {
            "query": normalized_query,
            "intent": intent,
            "results": deduplicated[:limit],
            "providers": providers,
            "partial": any(provider["status"] == "failed" for provider in providers),
        }

    def _crossref(
        self,
        query: str,
        *,
        limit: int,
        from_year: int | None,
        to_year: int | None,
    ) -> list[dict[str, Any]]:
        parameters: dict[str, str | int] = {
            "query.bibliographic": query,
            "rows": limit,
            "select": (
                "DOI,title,abstract,author,published,container-title,publisher,URL,"
                "resource,link,type"
            ),
        }
        filters = []
        if from_year is not None:
            filters.append(f"from-pub-date:{from_year}-01-01")
        if to_year is not None:
            filters.append(f"until-pub-date:{to_year}-12-31")
        if filters:
            parameters["filter"] = ",".join(filters)
        payload = self._json("crossref", f"{_CROSSREF_ENDPOINT}?{urlencode(parameters)}")
        message = payload.get("message")
        items = message.get("items") if isinstance(message, dict) else None
        if not isinstance(items, list):
            raise WebSearchProviderError("crossref", "invalid_response")
        return [result for item in items if (result := _crossref_result(item)) is not None]

    def _arxiv(
        self,
        query: str,
        *,
        limit: int,
        from_year: int | None,
        to_year: int | None,
    ) -> list[dict[str, Any]]:
        parameters = {
            "search_query": f'all:"{_arxiv_query(query)}"',
            "start": 0,
            "max_results": limit,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        response = self._request("arxiv", f"{_ARXIV_ENDPOINT}?{urlencode(parameters)}")
        try:
            root = ElementTree.fromstring(response.body)
        except ElementTree.ParseError as error:
            raise WebSearchProviderError("arxiv", "invalid_response") from error
        results = []
        for entry in root.findall("atom:entry", _ARXIV_NAMESPACE):
            result = _arxiv_result(entry)
            year = result.get("publication_year")
            if from_year is not None and (year is None or year < from_year):
                continue
            if to_year is not None and (year is None or year > to_year):
                continue
            results.append(result)
        return results

    def _json(self, provider: str, url: str) -> dict[str, Any]:
        response = self._request(provider, url)
        try:
            value = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WebSearchProviderError(provider, "invalid_response") from error
        if not isinstance(value, dict):
            raise WebSearchProviderError(provider, "invalid_response")
        return value

    def _request(self, provider: str, url: str) -> FetchResponse:
        try:
            response = self.fetch(url, self.timeout_seconds)
        except WebSearchProviderError:
            raise
        except TimeoutError as error:
            raise WebSearchProviderError(provider, "timeout") from error
        except (OSError, URLError) as error:
            raise WebSearchProviderError(provider, "network_error") from error
        if response.status == 429:
            raise WebSearchProviderError(provider, "rate_limited")
        if not 200 <= response.status < 300:
            raise WebSearchProviderError(provider, f"http_{response.status}")
        if len(response.body) > _MAX_RESPONSE_BYTES:
            raise WebSearchProviderError(provider, "response_too_large")
        return response


def _fetch(url: str, timeout_seconds: float) -> FetchResponse:
    request = Request(
        url,
        headers={
            "Accept": "application/json, application/atom+xml;q=0.9",
            "User-Agent": "hxaxd-research/0.1 (local literature workspace)",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
            declared = response.headers.get("Content-Length")
            if declared is not None and int(declared) > _MAX_RESPONSE_BYTES:
                raise WebSearchProviderError("remote", "response_too_large")
            body = response.read(_MAX_RESPONSE_BYTES + 1)
            return FetchResponse(status=response.status, body=body)
    except HTTPError as error:
        return FetchResponse(status=error.code, body=b"")


def _crossref_result(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    title = _first_string(value.get("title"))
    if title is None:
        return None
    doi = _string(value.get("DOI"))
    doi_url = f"https://doi.org/{doi}" if doi else None
    resource = value.get("resource")
    resource_url = None
    if isinstance(resource, dict) and isinstance(resource.get("primary"), dict):
        resource_url = _string(resource["primary"].get("URL"))
    landing_url = doi_url or _string(value.get("URL")) or resource_url
    if landing_url is None:
        return None
    authors = []
    for author in value.get("author", []) if isinstance(value.get("author"), list) else []:
        if not isinstance(author, dict):
            continue
        name = " ".join(
            part for part in (_string(author.get("given")), _string(author.get("family"))) if part
        )
        if name:
            authors.append(name)
    year = _crossref_year(value.get("published"))
    container = _first_string(value.get("container-title"))
    abstract = _plain_text(_string(value.get("abstract")))
    if not abstract:
        details = [str(year) if year else None, container, _string(value.get("publisher"))]
        abstract = (
            " · ".join(part for part in details if part)
            or "Crossref bibliographic metadata."
        )
    pdf_url = None
    links = value.get("link")
    if isinstance(links, list):
        for link in links:
            if not isinstance(link, dict):
                continue
            content_type = (_string(link.get("content-type")) or "").casefold()
            candidate = _string(link.get("URL"))
            if candidate and ("pdf" in content_type or candidate.casefold().endswith(".pdf")):
                pdf_url = candidate
                break
    return {
        "title": title,
        "url": landing_url,
        "snippet": _truncate(abstract),
        "source": "crossref",
        "source_id": doi or landing_url,
        "doi": doi,
        "authors": authors[:12],
        "publication_year": year,
        "container_title": container,
        "open_access": pdf_url is not None,
        "pdf_url": pdf_url,
    }


def _arxiv_result(entry: ElementTree.Element) -> dict[str, Any]:
    identifier = _element_text(entry, "atom:id") or ""
    title = _element_text(entry, "atom:title") or "Untitled arXiv record"
    summary = _element_text(entry, "atom:summary") or "arXiv preprint metadata."
    published = _element_text(entry, "atom:published")
    year = int(published[:4]) if published and published[:4].isdigit() else None
    authors = [
        name
        for author in entry.findall("atom:author", _ARXIV_NAMESPACE)
        if (name := _element_text(author, "atom:name"))
    ]
    landing_url = identifier
    pdf_url = None
    for link in entry.findall("atom:link", _ARXIV_NAMESPACE):
        href = link.get("href")
        if not href:
            continue
        if link.get("type") == "application/pdf" or link.get("title") == "pdf":
            pdf_url = href
        elif link.get("rel") == "alternate":
            landing_url = href
    arxiv_id = identifier.rstrip("/").rsplit("/", maxsplit=1)[-1]
    return {
        "title": _WHITESPACE.sub(" ", title).strip(),
        "url": landing_url,
        "snippet": _truncate(_plain_text(summary) or "arXiv preprint metadata."),
        "source": "arxiv",
        "source_id": arxiv_id,
        "doi": None,
        "authors": authors[:12],
        "publication_year": year,
        "container_title": "arXiv",
        "open_access": True,
        "pdf_url": pdf_url,
    }


def _deduplicate(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduplicated = []
    for result in results:
        doi = result.get("doi")
        key = (
            f"doi:{str(doi).casefold()}"
            if doi
            else "title:"
            + re.sub(r"\W+", "", str(result["title"]).casefold())
            + f":{result.get('publication_year')}"
        )
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(result)
    return deduplicated


def _first_string(value: object) -> str | None:
    if isinstance(value, list):
        return next(
            (item.strip() for item in value if isinstance(item, str) and item.strip()),
            None,
        )
    return _string(value)


def _string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _crossref_year(value: object) -> int | None:
    if not isinstance(value, dict):
        return None
    parts = value.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list) or not parts[0]:
        return None
    year = parts[0][0]
    return year if isinstance(year, int) else None


def _plain_text(value: str | None) -> str | None:
    if value is None:
        return None
    return _WHITESPACE.sub(" ", html.unescape(_HTML_TAG.sub(" ", value))).strip() or None


def _truncate(value: str, limit: int = 800) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _element_text(element: ElementTree.Element, path: str) -> str | None:
    child = element.find(path, _ARXIV_NAMESPACE)
    return _string(child.text) if child is not None else None


def _arxiv_query(value: str) -> str:
    return value.replace('"', " ").replace("\\", " ")
