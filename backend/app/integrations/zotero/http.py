from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

from .models import (
    ZoteroAttachmentAuthorization,
    ZoteroAttachmentUploadResult,
    ZoteroLibraryRef,
)

HttpBody = bytes | Iterable[bytes] | None


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class HttpTransport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: HttpBody = None,
        timeout: float = 15.0,
    ) -> HttpResponse: ...


class ZoteroHttpError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        response_body: bytes = b"",
        retry_after: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.response_body = response_body
        self.retry_after = retry_after


class UrllibTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_SafeRedirectHandler())

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: HttpBody = None,
        timeout: float = 15.0,
    ) -> HttpResponse:
        request = Request(url=url, data=body, headers=dict(headers or {}), method=method)
        try:
            with self._opener.open(request, timeout=timeout) as response:  # noqa: S310
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers.items()),
                    body=response.read(),
                )
        except HTTPError as error:
            response_body = error.read()
            raise ZoteroHttpError(
                f"Zotero HTTP request failed with status {error.code}",
                status=error.code,
                response_body=response_body,
                retry_after=error.headers.get("Retry-After"),
            ) from error
        except URLError as error:
            raise ZoteroHttpError(f"Zotero HTTP request failed: {error.reason}") from error


class _SafeRedirectHandler(HTTPRedirectHandler):
    """Do not forward Zotero credentials to cross-origin file storage redirects."""

    def redirect_request(self, request, fp, code, msg, headers, new_url):
        redirected = super().redirect_request(request, fp, code, msg, headers, new_url)
        if redirected is None:
            return None
        source = urlparse(request.full_url)
        target = urlparse(new_url)
        if (source.scheme.casefold(), source.netloc.casefold()) != (
            target.scheme.casefold(),
            target.netloc.casefold(),
        ):
            for collection in (redirected.headers, redirected.unredirected_hdrs):
                for name in list(collection):
                    if name.casefold() in {"authorization", "zotero-api-key"}:
                        collection.pop(name, None)
        return redirected


class ZoteroLocalClient:
    """Read-only client for Zotero Desktop's Web API-compatible local endpoint."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:23119/api/",
        transport: HttpTransport | None = None,
        timeout: float = 5.0,
    ) -> None:
        self.base_url = _normalized_base_url(base_url)
        self.transport = transport or UrllibTransport()
        self.timeout = timeout

    def probe(self) -> bool:
        try:
            self.schema()
        except ZoteroHttpError:
            return False
        return True

    def get_item(
        self,
        item_key: str,
        *,
        user_id: str = "0",
        library: ZoteroLibraryRef | None = None,
    ) -> dict[str, Any]:
        prefix = _local_library_path(library, user_id=user_id)
        return _expect_object(self._get(f"{prefix}/items/{item_key}"))

    def list_items(
        self,
        *,
        user_id: str = "0",
        start: int = 0,
        limit: int = 100,
        query: str | None = None,
        top: bool = False,
        library: ZoteroLibraryRef | None = None,
    ) -> list[dict[str, Any]]:
        prefix = _local_library_path(library, user_id=user_id)
        path = f"{prefix}/items" + ("/top" if top else "")
        params: dict[str, str | int] = {"start": start, "limit": limit}
        if query:
            params["q"] = query
        return _expect_object_list(self._get(path, params=params))

    def list_collections(self, *, user_id: str = "0") -> list[dict[str, Any]]:
        return _expect_object_list(self._get(f"users/{user_id}/collections"))

    def list_children(
        self,
        item_key: str,
        *,
        user_id: str = "0",
        library: ZoteroLibraryRef | None = None,
    ) -> list[dict[str, Any]]:
        prefix = _local_library_path(library, user_id=user_id)
        return _expect_object_list(self._get(f"{prefix}/items/{item_key}/children"))

    def attachment_file_path(
        self,
        item_key: str,
        *,
        user_id: str = "0",
        library: ZoteroLibraryRef | None = None,
    ) -> Path:
        prefix = _local_library_path(library, user_id=user_id)
        response = self._request(f"{prefix}/items/{item_key}/file/view/url")
        value: Any
        try:
            value = json.loads(response.body)
        except json.JSONDecodeError:
            value = response.body.decode("utf-8", errors="strict")
        if isinstance(value, dict):
            value = value.get("url") or value.get("path")
        if not isinstance(value, str) or not value.strip():
            raise ZoteroHttpError("Zotero did not return an attachment file URL")
        raw_value = value.strip()
        parsed = urlparse(raw_value)
        windows_drive = len(raw_value) >= 3 and raw_value[1] == ":" and raw_value[2] in {"/", "\\"}
        if parsed.scheme and parsed.scheme.casefold() != "file" and not windows_drive:
            raise ZoteroHttpError("Zotero attachment URL is not a local file")
        if parsed.scheme.casefold() == "file":
            raw_path = unquote(parsed.path)
            if parsed.netloc and parsed.netloc not in {"", "localhost"}:
                raw_path = f"//{parsed.netloc}{raw_path}"
            if len(raw_path) >= 3 and raw_path[0] == "/" and raw_path[2] == ":":
                raw_path = raw_path[1:]
            path = Path(raw_path)
        else:
            path = Path(raw_value)
        try:
            return path.resolve(strict=True)
        except OSError as error:
            raise ZoteroHttpError("Zotero attachment file is unavailable") from error

    def schema(self) -> dict[str, Any]:
        return _expect_object(self._get("schema"))

    def _get(self, path: str, *, params: Mapping[str, str | int] | None = None) -> Any:
        return _decode_json(self._request(path, params=params))

    def _request(
        self, path: str, *, params: Mapping[str, str | int] | None = None
    ) -> HttpResponse:
        url = _api_url(self.base_url, path, params)
        response = self.transport.request(
            "GET",
            url,
            headers={"Accept": "application/json", "Zotero-API-Version": "3"},
            timeout=self.timeout,
        )
        _expect_status(response, set(range(200, 300)))
        return response


class ZoteroWebClient:
    """Version-safe Zotero Web API writes and the three-step file upload protocol."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.zotero.org/",
        transport: HttpTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise ValueError("Zotero API key is required for Web API writes")
        self._api_key = api_key
        self.base_url = _normalized_base_url(base_url)
        self.transport = transport or UrllibTransport()
        self.timeout = timeout

    def get_item(self, library: ZoteroLibraryRef, item_key: str) -> dict[str, Any]:
        return _expect_object(self._json_request("GET", f"{library.path}/items/{item_key}"))

    def list_items(
        self,
        library: ZoteroLibraryRef,
        *,
        start: int = 0,
        limit: int = 100,
        since: int | None = None,
        top: bool = False,
    ) -> list[dict[str, Any]]:
        params: dict[str, int] = {"start": start, "limit": limit}
        if since is not None:
            params["since"] = since
        return _expect_object_list(
            self._json_request(
                "GET", f"{library.path}/items" + ("/top" if top else ""), params=params
            )
        )

    def list_children(
        self,
        library: ZoteroLibraryRef,
        item_key: str,
        *,
        start: int = 0,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return _expect_object_list(
            self._json_request(
                "GET",
                f"{library.path}/items/{item_key}/children",
                params={"start": start, "limit": limit},
            )
        )

    def download_attachment_file(
        self,
        library: ZoteroLibraryRef,
        item_key: str,
        destination: Path,
    ) -> Path:
        response = self._request(
            "GET",
            f"{library.path}/items/{item_key}/file",
            headers={"Accept": "application/pdf,application/octet-stream"},
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as output:
            output.write(response.body)
        return destination

    def create_items(
        self,
        library: ZoteroLibraryRef,
        items: list[dict[str, Any]],
        *,
        library_version: int | None = None,
        write_token: str | None = None,
    ) -> dict[str, Any]:
        if not 1 <= len(items) <= 50:
            raise ValueError("Zotero creates accept between 1 and 50 items")
        headers: dict[str, str] = {}
        if library_version is not None:
            headers["If-Unmodified-Since-Version"] = str(library_version)
        else:
            headers["Zotero-Write-Token"] = write_token or uuid4().hex
        result = self._json_request(
            "POST",
            f"{library.path}/items",
            json_body=items,
            headers=headers,
        )
        return _expect_object(result)

    def update_item(
        self,
        library: ZoteroLibraryRef,
        item_key: str,
        changes: dict[str, Any],
        *,
        expected_version: int,
    ) -> int | None:
        response = self._request(
            "PATCH",
            f"{library.path}/items/{item_key}",
            json_body=changes,
            headers={"If-Unmodified-Since-Version": str(expected_version)},
        )
        _expect_status(response, {200, 204})
        return _header_int(response.headers, "Last-Modified-Version")

    def create_attachment_item(
        self,
        library: ZoteroLibraryRef,
        *,
        parent_item: str | None,
        filename: str,
        content_type: str,
        title: str | None = None,
        library_version: int | None = None,
        write_token: str | None = None,
        object_key: str | None = None,
    ) -> str:
        attachment: dict[str, Any] = {
            "itemType": "attachment",
            "linkMode": "imported_file",
            "title": title or filename,
            "contentType": content_type,
            "filename": filename,
            "tags": [],
            "relations": {},
        }
        if parent_item:
            attachment["parentItem"] = parent_item
        if object_key is not None:
            attachment["key"] = object_key
        result = self.create_items(
            library,
            [attachment],
            library_version=library_version,
            write_token=write_token,
        )
        success = result.get("success")
        if not isinstance(success, dict) or not isinstance(success.get("0"), str):
            raise ZoteroHttpError("Zotero did not return the created attachment key")
        return success["0"]

    def upload_attachment_file(
        self,
        library: ZoteroLibraryRef,
        item_key: str,
        file_path: Path,
        *,
        previous_md5: str | None = None,
        mtime_ms: int | None = None,
    ) -> ZoteroAttachmentUploadResult:
        path = file_path.resolve(strict=True)
        size = path.stat().st_size
        modified = mtime_ms if mtime_ms is not None else path.stat().st_mtime_ns // 1_000_000
        md5 = _file_md5(path)
        precondition = {"If-Match": previous_md5} if previous_md5 else {"If-None-Match": "*"}
        authorization = self._authorize_attachment_upload(
            library,
            item_key,
            md5=md5,
            filename=path.name,
            size=size,
            mtime_ms=modified,
            precondition=precondition,
        )
        if authorization.exists:
            return ZoteroAttachmentUploadResult(
                item_key=item_key,
                filename=path.name,
                md5=md5,
                size=size,
                existed=True,
            )

        prefix = (authorization.prefix or "").encode()
        suffix = (authorization.suffix or "").encode()
        upload_url = _validated_upload_url(authorization.url or "")
        upload_response = self.transport.request(
            "POST",
            upload_url,
            headers={
                "Content-Type": authorization.content_type or "application/octet-stream",
                "Content-Length": str(len(prefix) + size + len(suffix)),
            },
            body=_FileUploadBody(prefix, path, suffix),
            timeout=self.timeout,
        )
        _expect_status(upload_response, {200, 201, 204})

        register_response = self._request(
            "POST",
            f"{library.path}/items/{item_key}/file",
            form_body={"upload": authorization.upload_key or ""},
            headers=precondition,
        )
        _expect_status(register_response, {200, 204})
        return ZoteroAttachmentUploadResult(
            item_key=item_key,
            filename=path.name,
            md5=md5,
            size=size,
            existed=False,
            library_version=_header_int(register_response.headers, "Zotero-Library-Version"),
        )

    def create_and_upload_attachment(
        self,
        library: ZoteroLibraryRef,
        *,
        parent_item: str | None,
        file_path: Path,
        content_type: str = "application/pdf",
        title: str | None = None,
        library_version: int | None = None,
        write_token: str | None = None,
        object_key: str | None = None,
    ) -> ZoteroAttachmentUploadResult:
        item_key = self.create_attachment_item(
            library,
            parent_item=parent_item,
            filename=file_path.name,
            content_type=content_type,
            title=title,
            library_version=library_version,
            write_token=write_token,
            object_key=object_key,
        )
        return self.upload_attachment_file(library, item_key, file_path)

    def _authorize_attachment_upload(
        self,
        library: ZoteroLibraryRef,
        item_key: str,
        *,
        md5: str,
        filename: str,
        size: int,
        mtime_ms: int,
        precondition: Mapping[str, str],
    ) -> ZoteroAttachmentAuthorization:
        result = self._json_request(
            "POST",
            f"{library.path}/items/{item_key}/file",
            form_body={
                "md5": md5,
                "filename": filename,
                "filesize": str(size),
                "mtime": str(mtime_ms),
            },
            headers=precondition,
        )
        value = _expect_object(result)
        if value.get("exists") == 1:
            return ZoteroAttachmentAuthorization(exists=True)
        return ZoteroAttachmentAuthorization(
            url=value.get("url"),
            content_type=value.get("contentType"),
            prefix=value.get("prefix"),
            suffix=value.get("suffix"),
            upload_key=value.get("uploadKey"),
        )

    def _json_request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        json_body: Any = None,
        form_body: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        return _decode_json(
            self._request(
                method,
                path,
                params=params,
                json_body=json_body,
                form_body=form_body,
                headers=headers,
            )
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        json_body: Any = None,
        form_body: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> HttpResponse:
        if json_body is not None and form_body is not None:
            raise ValueError("A Zotero request cannot contain JSON and form bodies together")
        request_headers = {
            "Accept": "application/json",
            "Zotero-API-Key": self._api_key,
            "Zotero-API-Version": "3",
            **dict(headers or {}),
        }
        body: bytes | None = None
        if json_body is not None:
            request_headers["Content-Type"] = "application/json"
            body = json.dumps(json_body, ensure_ascii=False, separators=(",", ":")).encode()
        elif form_body is not None:
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urlencode(form_body).encode()
        response = self.transport.request(
            method,
            _api_url(self.base_url, path, params),
            headers=request_headers,
            body=body,
            timeout=self.timeout,
        )
        _expect_status(response, set(range(200, 300)))
        return response


class _FileUploadBody:
    def __init__(self, prefix: bytes, path: Path, suffix: bytes) -> None:
        self.prefix = prefix
        self.path = path
        self.suffix = suffix

    def __iter__(self) -> Iterable[bytes]:
        if self.prefix:
            yield self.prefix
        with self.path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                yield chunk
        if self.suffix:
            yield self.suffix


def _file_md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_base_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Zotero base URL must be an absolute HTTP URL")
    return url.rstrip("/") + "/"


def _local_library_path(
    library: ZoteroLibraryRef | None, *, user_id: str = "0"
) -> str:
    if library is None:
        return f"users/{user_id}"
    if library.kind.value == "users":
        return "users/0"
    return f"groups/{library.id}"


def _api_url(
    base_url: str,
    path: str,
    params: Mapping[str, str | int] | None = None,
) -> str:
    url = urljoin(base_url, path.lstrip("/"))
    if params:
        url = f"{url}?{urlencode(params)}"
    return url


def _validated_upload_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ZoteroHttpError("Zotero returned an invalid attachment upload URL")
    return url


def _decode_json(response: HttpResponse) -> Any:
    if not response.body:
        return None
    try:
        return json.loads(response.body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ZoteroHttpError(
            "Zotero returned invalid JSON",
            status=response.status,
            response_body=response.body,
        ) from error


def _expect_status(response: HttpResponse, expected: set[int]) -> None:
    if response.status not in expected:
        raise ZoteroHttpError(
            f"Unexpected Zotero HTTP status {response.status}",
            status=response.status,
            response_body=response.body,
            retry_after=response.headers.get("Retry-After"),
        )


def _expect_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ZoteroHttpError("Zotero response must be a JSON object")
    return value


def _expect_object_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ZoteroHttpError("Zotero response must be a list of JSON objects")
    return value


def _header_int(headers: Mapping[str, str], name: str) -> int | None:
    value = next((value for key, value in headers.items() if key.lower() == name.lower()), None)
    return int(value) if value and value.isdigit() else None
