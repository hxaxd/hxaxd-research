from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from pydantic import ValidationError

from .models import (
    DocumentTranslationOutput,
    TranslationGlossaryTerm,
    TranslationInputBlock,
)
from .prompts import assemble_document_translation_prompt

MAX_SOURCE_CHARACTERS = 1_000_000


class DocumentTranslationError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class TranslationCapacity:
    max_input_characters: int
    max_output_tokens: int


@dataclass(frozen=True)
class TranslationProviderResponse:
    output: DocumentTranslationOutput
    request_id: str | None = None
    usage: dict[str, int | float | str | None] | None = None
    finish_reason: str | None = None


class TranslationProvider(Protocol):
    name: str
    model: str

    @property
    def ready(self) -> bool: ...

    @property
    def capacity(self) -> TranslationCapacity: ...

    def translate_document(
        self,
        blocks: list[TranslationInputBlock],
        target_language: str,
        *,
        model: str,
        style: str,
        glossary: list[TranslationGlossaryTerm],
        document_outline: list[str],
        batch_label: str,
        preceding_context: str | None,
        following_context: str | None,
        cancellation: Callable[[], bool],
    ) -> TranslationProviderResponse: ...


def estimate_translation_output_tokens(blocks: list[TranslationInputBlock]) -> int:
    """Conservatively budget translated JSON, not only the provider input window."""

    source_characters = sum(len(block.source_text) for block in blocks)
    return max(256, math.ceil(source_characters * 0.75) + len(blocks) * 24)


class OpenAICompatibleTranslationProvider:
    def __init__(
        self,
        *,
        name: str,
        model: str,
        base_url: str,
        api_key: str | None,
        timeout_seconds: float = 900,
        max_input_characters: int = MAX_SOURCE_CHARACTERS,
        max_output_tokens: int = 384_000,
    ) -> None:
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self._capacity = TranslationCapacity(
            max_input_characters=max_input_characters,
            max_output_tokens=max_output_tokens,
        )

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    @property
    def capacity(self) -> TranslationCapacity:
        return self._capacity

    def translate_document(
        self,
        blocks: list[TranslationInputBlock],
        target_language: str,
        *,
        model: str,
        style: str,
        glossary: list[TranslationGlossaryTerm],
        document_outline: list[str],
        batch_label: str,
        preceding_context: str | None,
        following_context: str | None,
        cancellation: Callable[[], bool],
    ) -> TranslationProviderResponse:
        if not self.api_key:
            raise DocumentTranslationError("credential_missing", "没有配置整篇翻译服务的 API 密钥")
        if cancellation():
            raise DocumentTranslationError("canceled", "整篇翻译已取消", retryable=True)
        source_characters = sum(len(block.source_text) for block in blocks)
        if source_characters > self.capacity.max_input_characters:
            raise DocumentTranslationError(
                "document_too_large",
                "文档超过整篇单次翻译的安全输入上限；不会静默退回碎片翻译",
            )
        if estimate_translation_output_tokens(blocks) > self.capacity.max_output_tokens:
            raise DocumentTranslationError(
                "document_output_too_large",
                "预计译文超过单次结构化输出上限；需要按章节调度",
            )
        prompt = assemble_document_translation_prompt(
            blocks,
            target_language,
            style=style,
            glossary=glossary,
            document_outline=document_outline,
            batch_label=batch_label,
            preceding_context=preceding_context,
            following_context=following_context,
        )
        body: dict[str, object] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "stream": True,
            "max_tokens": self.capacity.max_output_tokens,
        }
        if self.name.casefold() == "deepseek":
            body["thinking"] = {"type": "disabled"}
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "hxaxd-literature-workspace/4",
            },
            data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        try:
            with urllib.request.urlopen(  # noqa: S310 - configured provider is trusted
                request, timeout=self.timeout_seconds
            ) as response:
                content, finish_reason, request_id, usage = _consume_streaming_response(
                    response, cancellation
                )
        except urllib.error.HTTPError as error:
            retryable = error.code == 429 or error.code >= 500
            raise DocumentTranslationError(
                "provider_http_error",
                f"整篇翻译服务返回 HTTP {error.code}",
                retryable=retryable,
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise DocumentTranslationError(
                "provider_unavailable", "无法连接整篇翻译服务", retryable=True
            ) from error
        if cancellation():
            raise DocumentTranslationError("canceled", "整篇翻译已取消", retryable=True)
        if finish_reason != "stop":
            raise DocumentTranslationError(
                "translation_truncated" if finish_reason == "length" else "translation_incomplete",
                f"整篇翻译没有完整结束：{finish_reason}",
            )
        if not isinstance(content, str) or not content.strip():
            raise DocumentTranslationError("invalid_provider_response", "整篇翻译服务返回了空内容")
        try:
            decoded = json.loads(content)
            output = DocumentTranslationOutput.model_validate(decoded)
        except (json.JSONDecodeError, ValidationError) as error:
            raise DocumentTranslationError(
                "invalid_translation_output", "整篇翻译结果不符合严格 JSON 契约"
            ) from error
        return TranslationProviderResponse(
            output=output,
            request_id=request_id,
            usage=usage,
            finish_reason=finish_reason,
        )


def _consume_streaming_response(
    response, cancellation: Callable[[], bool]
) -> tuple[str, str | None, str | None, dict[str, int | float | str | None]]:
    content: list[str] = []
    finish_reason: str | None = None
    request_id: str | None = None
    usage: dict[str, int | float | str | None] = {}
    try:
        for raw_line in response:
            if cancellation():
                raise DocumentTranslationError("canceled", "整篇翻译已取消", retryable=True)
            line = raw_line.decode("utf-8").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            payload = json.loads(data)
            if request_id is None and isinstance(payload.get("id"), str):
                request_id = payload["id"]
            if isinstance(payload.get("usage"), dict):
                usage = {
                    str(key): value
                    for key, value in payload["usage"].items()
                    if value is None or isinstance(value, (int, float, str))
                }
            choice = payload["choices"][0]
            delta = choice.get("delta", {})
            part = delta.get("content")
            if isinstance(part, str):
                content.append(part)
            if choice.get("finish_reason") is not None:
                finish_reason = str(choice["finish_reason"])
    except DocumentTranslationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
        raise DocumentTranslationError(
            "invalid_provider_response", "整篇翻译服务返回了无效流式响应"
        ) from error
    return "".join(content), finish_reason, request_id, usage
