from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Protocol

from pydantic import ValidationError

from .models import (
    DocumentTranslationOutput,
    TranslationInputBlock,
)
from .prompts import assemble_document_translation_prompt

MAX_SOURCE_CHARACTERS = 1_000_000


class DocumentTranslationError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class TranslationProvider(Protocol):
    name: str
    model: str

    @property
    def ready(self) -> bool: ...

    def translate_document(
        self,
        blocks: list[TranslationInputBlock],
        target_language: str,
        *,
        cancellation: Callable[[], bool],
    ) -> DocumentTranslationOutput: ...


class OpenAICompatibleTranslationProvider:
    def __init__(
        self,
        *,
        name: str,
        model: str,
        base_url: str,
        api_key: str | None,
        timeout_seconds: float = 900,
    ) -> None:
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    def translate_document(
        self,
        blocks: list[TranslationInputBlock],
        target_language: str,
        *,
        cancellation: Callable[[], bool],
    ) -> DocumentTranslationOutput:
        if not self.api_key:
            raise DocumentTranslationError(
                "credential_missing", "没有配置整篇翻译服务的 API 密钥"
            )
        if cancellation():
            raise DocumentTranslationError("canceled", "整篇翻译已取消", retryable=True)
        source_characters = sum(len(block.source_text) for block in blocks)
        if source_characters > MAX_SOURCE_CHARACTERS:
            raise DocumentTranslationError(
                "document_too_large",
                "文档超过整篇单次翻译的安全输入上限；不会静默退回碎片翻译",
            )
        prompt = assemble_document_translation_prompt(blocks, target_language)
        body: dict[str, object] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "stream": True,
            "max_tokens": 384_000,
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
            data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            ),
        )
        try:
            with urllib.request.urlopen(  # noqa: S310 - configured provider is trusted
                request, timeout=self.timeout_seconds
            ) as response:
                content, finish_reason = _consume_streaming_response(
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
                "translation_truncated"
                if finish_reason == "length"
                else "translation_incomplete",
                f"整篇翻译没有完整结束：{finish_reason}",
            )
        if not isinstance(content, str) or not content.strip():
            raise DocumentTranslationError(
                "invalid_provider_response", "整篇翻译服务返回了空内容"
            )
        try:
            decoded = json.loads(content)
            return DocumentTranslationOutput.model_validate(decoded)
        except (json.JSONDecodeError, ValidationError) as error:
            raise DocumentTranslationError(
                "invalid_translation_output", "整篇翻译结果不符合严格 JSON 契约"
            ) from error


def _consume_streaming_response(
    response, cancellation: Callable[[], bool]
) -> tuple[str, str | None]:
    content: list[str] = []
    finish_reason: str | None = None
    try:
        for raw_line in response:
            if cancellation():
                raise DocumentTranslationError(
                    "canceled", "整篇翻译已取消", retryable=True
                )
            line = raw_line.decode("utf-8").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            payload = json.loads(data)
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
    return "".join(content), finish_reason
