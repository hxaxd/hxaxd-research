from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest

from app.agent_tools.web_search import (
    FetchResponse,
    LiteratureWebSearch,
    WebSearchUnavailableError,
)

_CROSSREF = {
    "status": "ok",
    "message": {
        "items": [
            {
                "DOI": "10.1000/example",
                "title": ["A structured literature result"],
                "abstract": "<jats:p>Evidence-backed abstract.</jats:p>",
                "author": [{"given": "Ada", "family": "Lovelace"}],
                "published": {"date-parts": [[2025, 2, 1]]},
                "container-title": ["Journal of Tests"],
                "URL": "https://doi.org/10.1000/example",
                "link": [
                    {
                        "URL": "https://publisher.test/example.pdf",
                        "content-type": "application/pdf",
                    }
                ],
            }
        ]
    },
}

_ARXIV = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://arxiv.org/abs/2501.00001v1</id>
    <title>Open preprint result</title>
    <summary>A complete open-access abstract.</summary>
    <published>2025-01-02T00:00:00Z</published>
    <author><name>Grace Hopper</name></author>
    <link rel="alternate" href="https://arxiv.org/abs/2501.00001v1" />
    <link title="pdf" type="application/pdf"
          href="https://arxiv.org/pdf/2501.00001v1" />
  </entry>
</feed>
"""


def _successful_fetch(url: str, timeout: float) -> FetchResponse:
    assert timeout == 3
    host = urlparse(url).hostname
    if host == "api.crossref.org":
        assert "query.bibliographic=" in url
        return FetchResponse(200, json.dumps(_CROSSREF).encode())
    assert host == "export.arxiv.org"
    assert "search_query=" in url
    return FetchResponse(200, _ARXIV)


def test_literature_web_search_returns_sourced_metadata_and_open_resources() -> None:
    service = LiteratureWebSearch(fetch=_successful_fetch, timeout_seconds=3)

    payload = service.search(
        "retrieval augmented generation",
        limit=5,
        intent="open_access",
        from_year=2024,
        to_year=2026,
    )

    assert payload["partial"] is False
    assert payload["providers"] == [
        {"name": "crossref", "status": "completed", "result_count": 1},
        {"name": "arxiv", "status": "completed", "result_count": 1},
    ]
    assert {result["source"] for result in payload["results"]} == {
        "crossref",
        "arxiv",
    }
    crossref = next(result for result in payload["results"] if result["source"] == "crossref")
    assert crossref["url"] == "https://doi.org/10.1000/example"
    assert crossref["snippet"] == "Evidence-backed abstract."
    assert crossref["doi"] == "10.1000/example"
    assert crossref["authors"] == ["Ada Lovelace"]
    assert crossref["pdf_url"] == "https://publisher.test/example.pdf"
    arxiv = next(result for result in payload["results"] if result["source"] == "arxiv")
    assert arxiv["open_access"] is True
    assert arxiv["pdf_url"] == "https://arxiv.org/pdf/2501.00001v1"


def test_literature_web_search_reports_rate_limit_but_returns_other_provider() -> None:
    def fetch(url: str, _timeout: float) -> FetchResponse:
        if urlparse(url).hostname == "api.crossref.org":
            return FetchResponse(429, b"secret upstream body must not escape")
        return FetchResponse(200, _ARXIV)

    payload = LiteratureWebSearch(fetch=fetch).search("agent systems")

    assert payload["partial"] is True
    assert payload["providers"][0] == {
        "name": "crossref",
        "status": "failed",
        "error_code": "rate_limited",
    }
    assert payload["results"][0]["source"] == "arxiv"


def test_literature_web_search_fails_closed_when_every_provider_is_unavailable() -> None:
    def fetch(_url: str, _timeout: float) -> FetchResponse:
        return FetchResponse(503, b"upstream details must not escape")

    with pytest.raises(WebSearchUnavailableError) as raised:
        LiteratureWebSearch(fetch=fetch).search("agent systems")

    assert str(raised.value) == (
        "all literature search providers failed: crossref=http_503, arxiv=http_503"
    )
    assert "upstream details" not in str(raised.value)


@pytest.mark.parametrize("query", ["", "  ", "x" * 501])
def test_literature_web_search_rejects_invalid_queries_without_network(query: str) -> None:
    called = False

    def fetch(_url: str, _timeout: float) -> FetchResponse:
        nonlocal called
        called = True
        raise AssertionError("network must not be reached")

    with pytest.raises(ValueError):
        LiteratureWebSearch(fetch=fetch).search(query)
    assert called is False
