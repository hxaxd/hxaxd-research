from __future__ import annotations

import hashlib
import json
from collections import deque
from urllib.request import Request

from app.integrations.zotero.http import (
    HttpResponse,
    ZoteroLocalClient,
    ZoteroWebClient,
    _SafeRedirectHandler,
)
from app.integrations.zotero.models import ZoteroLibraryKind, ZoteroLibraryRef


class FakeTransport:
    def __init__(self, *responses: HttpResponse):
        self.responses = deque(responses)
        self.requests: list[dict] = []

    def request(self, method, url, *, headers=None, body=None, timeout=15.0):
        captured_body = body if isinstance(body, bytes | type(None)) else b"".join(body)
        self.requests.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers or {}),
                "body": captured_body,
                "timeout": timeout,
            }
        )
        return self.responses.popleft()


def _response(status: int, payload=None, headers=None):
    body = b"" if payload is None else json.dumps(payload).encode()
    return HttpResponse(status=status, headers=headers or {}, body=body)


def test_local_client_is_read_only_and_uses_local_user_routes():
    transport = FakeTransport(_response(200, [{"key": "ITEM0001", "data": {}}]))
    client = ZoteroLocalClient(transport=transport)

    items = client.list_items(query="agent", top=True)

    assert items[0]["key"] == "ITEM0001"
    request = transport.requests[0]
    assert request["method"] == "GET"
    assert request["url"].startswith("http://127.0.0.1:23119/api/users/0/items/top?")
    assert "q=agent" in request["url"]
    assert "Zotero-API-Key" not in request["headers"]


def test_web_metadata_update_uses_item_version_precondition():
    transport = FakeTransport(_response(204, headers={"Last-Modified-Version": "18"}))
    client = ZoteroWebClient("secret", transport=transport)
    library = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")

    version = client.update_item(library, "ITEM0001", {"title": "Updated"}, expected_version=17)

    assert version == 18
    request = transport.requests[0]
    assert request["method"] == "PATCH"
    assert request["headers"]["If-Unmodified-Since-Version"] == "17"
    assert request["headers"]["Zotero-API-Key"] == "secret"
    assert json.loads(request["body"]) == {"title": "Updated"}


def test_attachment_creation_accepts_a_stable_object_key_and_write_token():
    transport = FakeTransport(_response(200, {"success": {"0": "ABCD2345"}}))
    client = ZoteroWebClient("secret", transport=transport)
    library = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")

    item_key = client.create_attachment_item(
        library,
        parent_item="PARENT23",
        filename="paper.pdf",
        content_type="application/pdf",
        object_key="ABCD2345",
        write_token="a" * 32,
    )

    assert item_key == "ABCD2345"
    request = transport.requests[0]
    assert request["headers"]["Zotero-Write-Token"] == "a" * 32
    assert json.loads(request["body"])[0]["key"] == "ABCD2345"


def test_attachment_upload_uses_authorize_upload_register_protocol(tmp_path):
    path = tmp_path / "paper.pdf"
    path.write_bytes(b"PDF DATA")
    transport = FakeTransport(
        _response(
            200,
            {
                "url": "https://storage.example.test/upload",
                "contentType": "multipart/form-data; boundary=x",
                "prefix": "PREFIX",
                "suffix": "SUFFIX",
                "uploadKey": "UPLOAD-KEY",
            },
        ),
        _response(201),
        _response(204, headers={"Zotero-Library-Version": "44"}),
    )
    client = ZoteroWebClient("secret", transport=transport)
    library = ZoteroLibraryRef(kind=ZoteroLibraryKind.GROUP, id="456")

    result = client.upload_attachment_file(library, "ATTACH01", path, mtime_ms=123_000)

    expected_md5 = hashlib.md5(b"PDF DATA", usedforsecurity=False).hexdigest()
    assert result.model_dump() == {
        "item_key": "ATTACH01",
        "filename": "paper.pdf",
        "md5": expected_md5,
        "size": 8,
        "existed": False,
        "library_version": 44,
    }
    authorize, upload, register = transport.requests
    assert authorize["url"].endswith("/groups/456/items/ATTACH01/file")
    assert authorize["headers"]["If-None-Match"] == "*"
    assert b"filename=paper.pdf" in authorize["body"]
    assert f"md5={expected_md5}".encode() in authorize["body"]
    assert upload["url"] == "https://storage.example.test/upload"
    assert upload["body"] == b"PREFIXPDF DATASUFFIX"
    assert "Zotero-API-Key" not in upload["headers"]
    assert register["headers"]["If-None-Match"] == "*"
    assert register["body"] == b"upload=UPLOAD-KEY"


def test_attachment_upload_stops_when_server_already_has_the_file(tmp_path):
    path = tmp_path / "paper.pdf"
    path.write_bytes(b"same")
    transport = FakeTransport(_response(200, {"exists": 1}))
    client = ZoteroWebClient("secret", transport=transport)
    library = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")

    result = client.upload_attachment_file(library, "ATTACH01", path)

    assert result.existed is True
    assert len(transport.requests) == 1


def test_local_client_resolves_attachment_file_without_database_access(tmp_path):
    path = (tmp_path / "paper.pdf").resolve()
    path.write_bytes(b"PDF")
    transport = FakeTransport(
        HttpResponse(status=200, headers={"Content-Type": "text/plain"}, body=str(path).encode())
    )
    client = ZoteroLocalClient(transport=transport)

    resolved = client.attachment_file_path("ATTACH01")

    assert resolved == path
    assert transport.requests[0]["url"].endswith(
        "/api/users/0/items/ATTACH01/file/view/url"
    )


def test_web_attachment_download_is_authenticated_and_written_to_destination(tmp_path):
    transport = FakeTransport(
        HttpResponse(
            status=200,
            headers={"Content-Type": "application/pdf"},
            body=b"PDF DATA",
        )
    )
    client = ZoteroWebClient("secret", transport=transport)
    library = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")
    destination = tmp_path / "download.pdf"

    client.download_attachment_file(library, "ATTACH01", destination)

    assert destination.read_bytes() == b"PDF DATA"
    request = transport.requests[0]
    assert request["url"].endswith("/users/123/items/ATTACH01/file")
    assert request["headers"]["Zotero-API-Key"] == "secret"


def test_cross_origin_download_redirect_drops_zotero_api_key():
    request = Request(
        "https://api.zotero.org/users/123/items/ATTACH01/file",
        headers={"Zotero-API-Key": "secret"},
    )

    redirected = _SafeRedirectHandler().redirect_request(
        request,
        None,
        302,
        "Found",
        {},
        "https://storage.zotero.example/signed-file",
    )

    assert redirected is not None
    assert all(name.casefold() != "zotero-api-key" for name in redirected.headers)
